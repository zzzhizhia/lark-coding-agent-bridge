import type { NotesSyncConfig } from '../config/profile-schema';
import { log } from '../core/logger';
import { mergeProcessEnv, spawnProcess } from '../platform/spawn';

/**
 * Feishu's "note generated" push (`vc.note.generated_v1`), user-scoped
 * (`vc:note:read`, user auth).
 *
 * The console checkbox alone does not create a user-identity subscription — the
 * user has to subscribe through the API (`POST /open-apis/vc/v1/notes/subscription`)
 * before the platform pushes anything. The payload carries `note_token`.
 */
export const NOTES_GENERATED_EVENT = 'vc.note.generated_v1';

/**
 * Feishu's "minute generated" push (`minutes.minute.generated_v1`), also
 * user-scoped, subscribed through `POST /open-apis/minutes/v1/minutes/subscription`.
 *
 * A 妙记 is generated alongside its 「我的笔记」 document — one second before it in
 * the recording flow we measured — and it is the event this app actually
 * receives today, while the note push stays silent. The hook therefore treats
 * both as triggers: the command lists the drive and skips what it already
 * imported, so an extra trigger costs one listing and can only make the sync
 * earlier.
 */
export const MINUTES_GENERATED_EVENT = 'minutes.minute.generated_v1';

/** Every push that means "a note may exist now". */
const TRIGGER_EVENTS = [NOTES_GENERATED_EVENT, MINUTES_GENERATED_EVENT] as const;

/**
 * The slice of `LarkChannel` we subscribe through — same structural probe as
 * {@link import('../meeting/manager').MeetingManager}, so a channel older than
 * `@larksuite/channel` 0.5.0 degrades to "no hook" instead of throwing.
 */
interface RawEventSource {
  onRawEvent(
    eventType: string,
    handler: (payload: unknown) => void | Promise<void>,
  ): () => void;
}

export interface NotesSyncHealth {
  /** Whether the push subscriptions were installed. */
  hooked: boolean;
  /** Why it could not be installed (disabled / no command / old SDK). */
  reason?: string;
  /** Count of note pushes observed — proves the console subscription works. */
  received: number;
  lastAt?: string;
  /** Local commands spawned (first run + retries). */
  runs: number;
  lastRunAt?: string;
}

export type NotesSyncRunner = (
  command: readonly string[],
  env?: NodeJS.ProcessEnv,
) => void;

export interface NotesSyncHookDeps {
  /** The channel object; only its `onRawEvent` is used, and only if present. */
  channel?: unknown;
  /** Live config accessor — re-read per use so `/config` edits apply. */
  config: () => NotesSyncConfig;
  /**
   * Bridge-bound lark-cli env (`LARK_CHANNEL*`), merged over `process.env` for
   * the child. The bridge daemon itself only carries `LARK_CHANNEL_HOME`, so a
   * sync script that shells out to lark-cli needs these to stay on this
   * profile instead of the machine's global config.
   */
  env?: NodeJS.ProcessEnv;
  /** Test seam for the child process. */
  run?: NotesSyncRunner;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Spawn the configured command with the bridge's environment (which carries the
 * `LARK_CHANNEL*` profile pointers, so a lark-cli-based script stays bound to
 * this profile). Output goes to the script's own log; only failures are
 * surfaced here, with a bounded stderr tail.
 */
export function spawnNotesCommand(command: readonly string[], env?: NodeJS.ProcessEnv): void {
  const [bin, ...args] = command;
  if (!bin) return;
  let stderr = '';
  try {
    const child = spawnProcess(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: mergeProcessEnv(process.env, env ?? {}),
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 600) stderr += String(chunk);
    });
    child.on('error', (err) => {
      log.warn('notes', 'sync-spawn-failed', { bin, err: String(err) });
    });
    child.on('close', (code) => {
      if (code === 0) log.info('notes', 'sync-done', { bin });
      else log.warn('notes', 'sync-failed', { bin, code, stderr: stderr.trim().slice(0, 500) });
    });
  } catch (err) {
    log.warn('notes', 'sync-spawn-failed', { bin, err: String(err) });
  }
}

/** Recent `event_id`s kept for at-least-once delivery dedup. */
const MAX_SEEN_EVENTS = 64;

export class NotesSyncHook {
  private unsubscribers: (() => void)[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private health: NotesSyncHealth = { hooked: false, received: 0, runs: 0 };
  private disposed = false;

  constructor(private deps: NotesSyncHookDeps) {}

  healthState(): NotesSyncHealth {
    return { ...this.health };
  }

  /**
   * Subscribe to the note push on the channel's existing event connection.
   * Riding the existing connection is mandatory: a second long connection for
   * the same app makes Feishu split delivery between the two, so the bridge's
   * own IM traffic starts disappearing (see `MeetingManager.attachPush`).
   */
  attach(): NotesSyncHealth {
    const cfg = this.deps.config();
    if (!cfg.enabled) {
      this.health = { hooked: false, reason: 'notesSync 未启用', received: 0, runs: 0 };
      return this.healthState();
    }
    if (cfg.command.length === 0) {
      this.health = { hooked: false, reason: 'notesSync.command 为空', received: 0, runs: 0 };
      log.warn('notes', 'sync-hook-no-command', {});
      return this.healthState();
    }
    const channel = this.deps.channel as RawEventSource | undefined;
    if (typeof channel?.onRawEvent !== 'function') {
      this.health = {
        hooked: false,
        reason: 'channel 不支持 onRawEvent（需要 @larksuite/channel >= 0.5.0）',
        received: 0,
        runs: 0,
      };
      log.warn('notes', 'sync-hook-unavailable', { reason: this.health.reason });
      return this.healthState();
    }
    try {
      for (const eventType of TRIGGER_EVENTS) {
        this.unsubscribers.push(channel.onRawEvent(eventType, (data) => this.handle(data)));
      }
      this.health = { ...this.health, hooked: true };
      log.info('notes', 'sync-hooked', { events: [...TRIGGER_EVENTS] });
    } catch (err) {
      this.detach();
      this.health = { hooked: false, reason: `注册事件失败：${String(err)}`, received: 0, runs: 0 };
      log.warn('notes', 'sync-hook-failed', { err: String(err) });
    }
    return this.healthState();
  }

  /**
   * Cheap by contract: the SDK awaits raw handlers before acking the push, so
   * this only records the push and schedules timers. The actual sync runs off
   * the dispatch path.
   */
  private handle(data: unknown): void {
    if (this.disposed) return;
    const cfg = this.deps.config();
    if (!cfg.enabled || cfg.command.length === 0) return;
    const d = asRecord(data);
    this.health.received += 1;
    this.health.lastAt = new Date().toISOString();

    const dedupKey = this.dedupKey(d);
    if (dedupKey && !this.remember(dedupKey)) {
      log.info('notes', 'sync-duplicate-push', { eventId: dedupKey });
      return;
    }
    const noteToken = typeof d.note_token === 'string' ? d.note_token : undefined;
    log.info('notes', 'push-received', { ...(noteToken ? { noteToken } : {}) });

    // First attempt after the configured delay, then the retries. The doc may
    // still be generating; the command is idempotent, so a re-run is safe.
    this.schedule(cfg.delayMs);
    for (const delay of cfg.retryDelaysMs) this.schedule(delay);
  }

  /** `event_id` when present, else a token+timestamp fallback, else none. */
  private dedupKey(d: Record<string, unknown>): string | undefined {
    if (typeof d.event_id === 'string' && d.event_id) return d.event_id;
    const token = typeof d.note_token === 'string' ? d.note_token : '';
    const ts = typeof d.timestamp === 'string' ? d.timestamp : '';
    return token || ts ? `${token}:${ts}` : undefined;
  }

  private schedule(delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      // Re-read at fire time: a `/config` disable must cancel pending work too.
      const cfg = this.deps.config();
      if (!cfg.enabled || cfg.command.length === 0) return;
      this.health.runs += 1;
      this.health.lastRunAt = new Date().toISOString();
      (this.deps.run ?? spawnNotesCommand)(cfg.command, this.deps.env);
    }, delayMs);
    this.timers.add(timer);
  }

  private remember(key: string): boolean {
    if (this.seenSet.has(key)) return false;
    this.seenSet.add(key);
    this.seen.push(key);
    if (this.seen.length > MAX_SEEN_EVENTS) {
      const evicted = this.seen.shift();
      if (evicted) this.seenSet.delete(evicted);
    }
    return true;
  }

  /** Drop the subscription and every pending run. Idempotent. */
  detach(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const offs = this.unsubscribers.splice(0);
    for (const off of offs) {
      try {
        off();
      } catch {
        // A channel torn down under us — nothing left to unsubscribe from.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.seen = [];
    this.seenSet.clear();
    this.health = { ...this.health, hooked: false };
  }
}
