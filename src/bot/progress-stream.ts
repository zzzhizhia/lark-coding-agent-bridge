import type { Block, RunState } from '../card/run-state';
import { renderTextFrom } from '../card/text-renderer';
import { log } from '../core/logger';

/**
 * Feishu ends a card's streaming mode ten minutes after it was enabled:
 * "流式更新模式将在距上次开启 10 分钟后自动关闭" (error 200850, Card streaming
 * timeout). Updates sent to an aged-out card are accepted and then dropped, so
 * the card silently freezes on its last pre-deadline frame: nothing throws and
 * nothing reaches the logs. A run that outlives the lease therefore loses the
 * tail of its reply — including the answer, which rides on the same card.
 *
 * https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview
 */
const DEFAULT_STREAM_LEASE_MS = 10 * 60_000;

/** Rotate this far into the lease, leaving the hand-off itself room to finish. */
const ROTATE_AT_LEASE_FRACTION = 0.8;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** How long a streaming card keeps accepting updates. */
export function streamLeaseMs(): number {
  return envNumber('LARK_CHANNEL_STREAM_LEASE_MS') ?? DEFAULT_STREAM_LEASE_MS;
}

/**
 * Age at which a streaming card is continued on a fresh one. `0` turns rotation
 * off — the delivery guard in channel.ts still guarantees the answer.
 */
export function streamRotateAfterMs(): number {
  return (
    envNumber('LARK_CHANNEL_STREAM_ROTATE_MS') ??
    Math.round(streamLeaseMs() * ROTATE_AT_LEASE_FRACTION)
  );
}

export interface LazyProgressStream {
  /**
   * Mirrors the underlying `channel.stream(...)` promise, and stays pending
   * forever while no stream has been opened — so callers can race it against
   * the render loop exactly as if the stream had been created up front.
   */
  readonly settled: Promise<unknown>;
  opened(): boolean;
  ensureOpen(): void;
  /**
   * True once the reply went out without this stream. A producer that starts
   * after that must render nothing, or the user gets the same answer twice.
   */
  abandoned(): boolean;
  abandon(): void;
}

/**
 * Wrap a progress stream so the user-visible message is only created once the
 * run has something worth showing (see `shouldOpenProgressStream`).
 *
 * The SDK starts a stream eagerly: `channel.stream(...)` sends a card before
 * the producer runs, and finishes it with a "(no content)" placeholder when the
 * producer never supplied any text. A Codex round that only produces a final
 * answer (delivered separately by `sendFinalReply`) used to hit exactly that:
 * an empty card sat in the chat for seconds until `recall-empty` cleaned it up.
 */
export function createLazyProgressStream(
  scope: string,
  mode: 'card' | 'markdown',
  open: () => Promise<unknown>,
): LazyProgressStream {
  let stream: Promise<unknown> | undefined;
  let givenUp = false;
  let settle!: (result: Promise<unknown>) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    settle = (result) => {
      result.then(resolve, reject);
    };
  });
  return {
    settled,
    opened: () => stream !== undefined,
    ensureOpen: () => {
      if (stream) return;
      log.info('outbound', 'progress-stream-open', { scope, mode });
      stream = open();
      settle(stream);
    },
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
    },
  };
}

/** The subset of the SDK's markdown stream controller this module drives. */
export interface StreamController {
  setContent(markdown: string): Promise<void>;
}

export interface MarkdownProgressStream extends LazyProgressStream {
  /** Hand the current render to the live card, rotating it first if it aged out. */
  push(): Promise<void>;
  /** Seal the live card: the run is over, so nothing else will be pushed. */
  finish(): void;
  /**
   * True once every one of `parts` reached a card that was still inside its
   * lease. Callers pass one part per rendered block: a reply can span several
   * cards (rotation never splits a block), so the check has to be per block
   * rather than on the concatenation, which no single card ever held.
   */
  trustedShowsAll(parts: readonly string[]): boolean;
  /** How many continuation cards were opened after the first one. */
  rotations(): number;
  /** True once the SDK ran a producer, i.e. a card is really being written. */
  producerStarted(): boolean;
}

/** A block that can still change under the card that already rendered it. */
function blockIsLive(block: Block | undefined): boolean {
  if (!block) return false;
  return block.kind === 'text' ? block.streaming : block.tool.status === 'running';
}

interface Session {
  /** First block this card renders: everything before it is on earlier cards. */
  startBlock: number;
  /** Ordinal in `liveTexts`, so text from sealed cards is not attributed twice. */
  ordinal: number;
  openedAt: number;
  /** Highest block count handed to this card, i.e. what it is known to show. */
  shownBlocks: number;
  /** Whether the last block it rendered was still being written. */
  shownTailLive: boolean;
  ctrl?: StreamController;
  /** Resolves the producer, which is what seals (and stops streaming) the card. */
  release: () => void;
  sealed: Promise<unknown>;
}

/**
 * A markdown progress card that outlives Feishu's streaming lease.
 *
 * The reply is one logical stream spread over however many cards it takes: when
 * the live card approaches the 10-minute deadline it is sealed and the rest of
 * the render continues on a fresh card, starting at the block the previous one
 * stopped at. Nothing is repeated and nothing is lost, and the answer always
 * lands on a card that was still writable.
 *
 * `trustedShows` is the other half of that guarantee: it remembers what live
 * cards were actually told to show, so the caller can tell an answer that made
 * it onto the screen from one that Feishu silently dropped.
 */
export function createMarkdownProgressStream(deps: {
  scope: string;
  /** Read at push time — the run moves on between pushes. */
  state: () => RunState;
  /** `channel.stream(chatId, { markdown: producer }, sendOpts)`. */
  open: (producer: (ctrl: StreamController) => Promise<void>) => Promise<unknown>;
  now?: () => number;
  leaseMs?: number;
  /** 0 disables rotation. */
  rotateAfterMs?: number;
}): MarkdownProgressStream {
  const now = deps.now ?? (() => Date.now());
  const leaseMs = deps.leaseMs ?? streamLeaseMs();
  const rotateAfterMs = deps.rotateAfterMs ?? streamRotateAfterMs();

  let session: Session | undefined;
  let rotations = 0;
  let started = false;
  let givenUp = false;
  let finished = false;
  /** Last text each card showed while it was inside its lease. */
  const liveTexts: string[] = [];
  let resolveSettled!: (value: unknown) => void;
  let rejectSettled!: (reason: unknown) => void;
  const settled = new Promise<unknown>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  // `settled` mirrors the card the reply ends on: a card we rotated away from
  // settling first is not the stream the caller is waiting for.
  const seal = (target: Session): void => {
    target.sealed.then(
      (value) => {
        if (session === target) resolveSettled(value);
      },
      (err) => {
        if (session === target) rejectSettled(err);
      },
    );
  };

  /**
   * Remember what the live card was told to show. Only updates handed to a card
   * still inside its lease count: after that Feishu keeps accepting them and
   * drops them, which is what `trustedShows` exists to detect.
   */
  const recordLive = (target: Session, text: string, state: RunState): void => {
    if (now() - target.openedAt >= leaseMs) return;
    target.shownBlocks = state.blocks.length;
    target.shownTailLive = blockIsLive(state.blocks.at(-1));
    liveTexts[target.ordinal] = text;
  };

  /**
   * Where a continuation card picks up. A block that was still being written
   * when the previous card rendered it is started over — one block may repeat,
   * but nothing the user never saw can be skipped. A settled tail is taken as
   * rendered, so rotation does not repeat it.
   */
  const continuationBlock = (previous: Session): number =>
    previous.shownTailLive
      ? Math.max(previous.startBlock, previous.shownBlocks - 1)
      : previous.shownBlocks;

  const openSession = (startBlock: number): Session => {
    const ord = rotations;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target: Session = {
      startBlock,
      ordinal: ord,
      openedAt: now(),
      shownBlocks: startBlock,
      shownTailLive: false,
      release,
      sealed: Promise.resolve<unknown>(undefined),
    };

    target.sealed = deps.open(async (ctrl) => {
      started = true;
      if (givenUp) return;
      target.ctrl = ctrl;
      const state = deps.state();
      const text = renderTextFrom(state, target.startBlock);
      await ctrl.setContent(text);
      recordLive(target, text, state);
      await held;
    });
    // A card that settles before the run does reports through `settled` when it
    // is the live one; the rest are rotated-away cards whose failure the run has
    // already moved past.
    target.sealed.catch(() => undefined);
    session = target;
    return target;
  };

  const rotate = async (previous: Session): Promise<void> => {
    // Claim the next ordinal before opening: what the new card records must not
    // land in the slot of the card it replaced, or the text the old card showed
    // is forgotten and the answer looks undelivered.
    rotations += 1;
    const next = openSession(continuationBlock(previous));
    seal(next);
    log.info('outbound', 'progress-stream-rotate', {
      scope: deps.scope,
      mode: 'markdown',
      rotation: next.ordinal,
      startBlock: next.startBlock,
      ageMs: now() - previous.openedAt,
      leaseMs,
    });
    // Seal the aged card before opening on it again: the SDK finishes the
    // message (and turns its streaming mode off) once the producer returns.
    previous.release();
    await previous.sealed.catch(() => undefined);
  };

  return {
    settled,
    opened: () => session !== undefined,
    producerStarted: () => started,
    rotations: () => rotations,
    abandoned: () => givenUp,
    abandon: () => {
      givenUp = true;
      session?.release();
    },
    finish: () => {
      finished = true;
      session?.release();
    },
    trustedShowsAll: (parts: readonly string[]) =>
      parts.every((part) => {
        const needle = part.trim();
        return needle !== '' && liveTexts.some((text) => text.includes(needle));
      }),
    ensureOpen: () => {
      if (session) return;
      log.info('outbound', 'progress-stream-open', { scope: deps.scope, mode: 'markdown' });
      seal(openSession(0));
    },
    async push() {
      if (givenUp || finished) return;
      let live = session;
      if (!live) return;
      let state = deps.state();
      // Rotate ahead of the deadline, never after it: a continuation opened on a
      // card that already aged out would be written to a message nobody sees.
      const ageMs = now() - live.openedAt;
      if (
        rotateAfterMs > 0 &&
        ageMs >= rotateAfterMs &&
        state.blocks.length > live.startBlock
      ) {
        await rotate(live);
        live = session;
        if (!live) return;
        state = deps.state();
      }
      // The producer renders the first frame itself, so a push that beats it is
      // not a lost update — the card is simply not writable yet.
      if (!live.ctrl) return;
      const text = renderTextFrom(state, live.startBlock);
      await live.ctrl.setContent(text);
      // Leaving `shownBlocks` where it was makes the next rotation re-render
      // whatever the user never saw.
      recordLive(live, text, state);
    },
  };
}
