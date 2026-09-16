import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMarkdownProgressStream,
  streamLeaseMs,
  streamRotateAfterMs,
  type StreamController,
} from '../../../src/bot/progress-stream.js';
import { initialState, type Block, type RunState } from '../../../src/card/run-state.js';

function textBlock(content: string, streaming = false): Block {
  return { kind: 'text', content, streaming };
}

function toolBlock(status: 'running' | 'done'): Block {
  return { kind: 'tool', tool: { id: 't1', name: 'bash', input: {}, status } };
}

function state(blocks: Block[], extra: Partial<RunState> = {}): RunState {
  return { ...initialState, blocks, ...extra };
}

/** Stands in for `channel.stream`: resolves once the producer returns. */
function createFakeStreams() {
  const cards: Array<{ texts: string[]; ctrl: StreamController }> = [];
  const open = (producer: (ctrl: StreamController) => Promise<void>): Promise<unknown> => {
    const record = { texts: [] as string[], ctrl: undefined as unknown as StreamController };
    cards.push(record);
    record.ctrl = {
      async setContent(markdown: string) {
        record.texts.push(markdown);
      },
    };
    return producer(record.ctrl).then(() => ({ messageId: `om_${cards.length}` }));
  };
  return { cards, open };
}

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMarkdownProgressStream', () => {
  it('renders the first frame when the producer starts', async () => {
    const streams = createFakeStreams();
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => state([textBlock('hello')]),
      open: streams.open,
      leaseMs: 1000,
      rotateAfterMs: 800,
    });

    expect(progress.opened()).toBe(false);
    progress.ensureOpen();
    await tick();

    expect(progress.opened()).toBe(true);
    expect(streams.cards[0]?.texts[0]).toContain('hello');
    expect(progress.trustedShowsAll(['hello'])).toBe(true);

    progress.finish();
    await expect(progress.settled).resolves.toEqual({ messageId: 'om_1' });
  });

  it('continues on a fresh card before the lease expires, repeating nothing settled', async () => {
    const streams = createFakeStreams();
    const clock = createClock();
    let current = state([textBlock('progress one')]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open: streams.open,
      now: clock.now,
      leaseMs: 1000,
      rotateAfterMs: 800,
    });

    progress.ensureOpen();
    await tick();
    expect(streams.cards).toHaveLength(1);

    current = state([textBlock('progress one'), textBlock('progress two')]);
    clock.advance(900);
    await progress.push();

    expect(streams.cards).toHaveLength(2);
    // The continuation opens where the previous card stopped: the settled block
    // is not replayed, the new one is not lost.
    expect(streams.cards[1]?.texts[0]).toContain('progress two');
    expect(streams.cards[1]?.texts[0]).not.toContain('progress one');
    expect(progress.rotations()).toBe(1);
  });

  it('re-renders the block that was still being written when it rotates', async () => {
    const streams = createFakeStreams();
    const clock = createClock();
    let current = state([textBlock('half', true)]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open: streams.open,
      now: clock.now,
      leaseMs: 1000,
      rotateAfterMs: 800,
    });

    progress.ensureOpen();
    await tick();

    // The block grew after the first card rendered it: starting the new card
    // past it would silently drop the words the user never saw.
    current = state([textBlock('half of it, and the rest', true)]);
    clock.advance(900);
    await progress.push();

    expect(streams.cards[1]?.texts[0]).toContain('half of it, and the rest');
  });

  it('keeps rendering inside the lease, and stops trusting what comes after it', async () => {
    const streams = createFakeStreams();
    const clock = createClock();
    let current = state([textBlock('progress')]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open: streams.open,
      now: clock.now,
      leaseMs: 1000,
      rotateAfterMs: 0,
    });

    progress.ensureOpen();
    await tick();

    clock.advance(5000);
    current = state([textBlock('progress'), textBlock('ANSWER')]);
    await progress.push();

    // The update is still attempted — Feishu accepts it and drops it — so the
    // only honest answer to "did the user see it?" is no.
    expect(streams.cards[0]?.texts.at(-1)).toContain('ANSWER');
    expect(progress.trustedShowsAll(['ANSWER'])).toBe(false);
    expect(progress.trustedShowsAll(['progress'])).toBe(true);
  });

  it('does not count an update the API rejected', async () => {
    const texts: string[] = [];
    let calls = 0;
    const open = async (producer: (ctrl: StreamController) => Promise<void>): Promise<unknown> => {
      await producer({
        async setContent(markdown: string) {
          calls += 1;
          if (calls > 1) throw new Error('rate limited');
          texts.push(markdown);
        },
      });
      return { messageId: 'om_1' };
    };
    let current = state([textBlock('progress')]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open,
      leaseMs: 1000,
      rotateAfterMs: 0,
    });

    progress.ensureOpen();
    await tick();

    current = state([textBlock('progress'), textBlock('ANSWER')]);
    await expect(progress.push()).rejects.toThrow('rate limited');

    expect(progress.trustedShowsAll(['progress'])).toBe(true);
    expect(progress.trustedShowsAll(['ANSWER'])).toBe(false);
  });

  it('seals the live card when the run gives up on the stream', async () => {
    const streams = createFakeStreams();
    let current = state([textBlock('progress')]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open: streams.open,
      leaseMs: 1000,
      rotateAfterMs: 800,
    });

    progress.ensureOpen();
    await tick();
    current = state([textBlock('progress'), textBlock('late')], { footer: null });
    progress.abandon();
    await expect(progress.push()).resolves.toBeUndefined();

    expect(progress.abandoned()).toBe(true);
    expect(streams.cards).toHaveLength(1);
    await expect(progress.settled).resolves.toEqual({ messageId: 'om_1' });
  });

  it('treats a reply spread over rotated cards as shown when every block landed', async () => {
    const streams = createFakeStreams();
    const clock = createClock();
    let current = state([textBlock('first half')]);
    const progress = createMarkdownProgressStream({
      scope: 'oc_dm',
      state: () => current,
      open: streams.open,
      now: clock.now,
      leaseMs: 1000,
      rotateAfterMs: 800,
    });

    progress.ensureOpen();
    await tick();

    current = state([textBlock('first half'), textBlock('second half')]);
    clock.advance(900);
    await progress.push();

    // The reply lives on two cards now; no single card ever held the whole
    // thing, so the check has to be per block — and must hold either way.
    expect(progress.trustedShowsAll(['first half', 'second half'])).toBe(true);
    expect(progress.trustedShowsAll(['first half', 'and more'])).toBe(false);
  });

  it('reads its bounds from the environment so a long lease can be exercised', () => {
    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', '500');
    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '400');
    expect(streamLeaseMs()).toBe(500);
    expect(streamRotateAfterMs()).toBe(400);

    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '');
    expect(streamRotateAfterMs()).toBe(400);

    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', 'not-a-number');
    expect(streamLeaseMs()).toBe(600_000);
  });
});
