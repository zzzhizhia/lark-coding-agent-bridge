import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTES_SYNC_DEFAULTS, type NotesSyncConfig } from '../../../src/config/profile-schema';
import { spawnProcess } from '../../../src/platform/spawn';
import {
  MINUTES_GENERATED_EVENT,
  NOTES_GENERATED_EVENT,
  NotesSyncHook,
  spawnNotesCommand,
  type NotesSyncRunner,
} from '../../../src/notes/sync-hook';

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: vi.fn() };
});

type Handler = (data: unknown) => unknown;

/** Fake channel exposing the SDK's public `onRawEvent` subscription. */
function fakeChannel(): { channel: unknown; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    channel: {
      onRawEvent(eventType: string, handler: Handler) {
        handlers.set(eventType, handler);
        return () => handlers.delete(eventType);
      },
    },
  };
}

function cfg(over: Partial<NotesSyncConfig> = {}): NotesSyncConfig {
  return {
    ...NOTES_SYNC_DEFAULTS,
    enabled: true,
    command: ['/usr/bin/python3', '/tmp/sync.py'],
    delayMs: 1000,
    retryDelaysMs: [5000, 30_000],
    ...over,
  };
}

function hook(opts: {
  channel?: unknown;
  config?: NotesSyncConfig;
  run?: NotesSyncRunner;
  configRef?: { current: NotesSyncConfig };
}) {
  const ref = opts.configRef ?? { current: opts.config ?? cfg() };
  const run = vi.fn(opts.run);
  return {
    ref,
    run,
    hook: new NotesSyncHook({
      ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
      config: () => ref.current,
      run,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NotesSyncHook attach', () => {
  it('subscribes to vc.note.generated_v1 through channel.onRawEvent', () => {
    const { channel, handlers } = fakeChannel();
    const health = hook({ channel }).hook.attach();

    expect(health.hooked).toBe(true);
    expect([...handlers.keys()]).toEqual([NOTES_GENERATED_EVENT, MINUTES_GENERATED_EVENT]);
  });

  it('degrades with a reason (not a throw) when onRawEvent is unavailable', () => {
    // Simulates a channel-sdk older than 0.5.0, which has no onRawEvent.
    const health = hook({ channel: { somethingElse: true } }).hook.attach();
    expect(health.hooked).toBe(false);
    expect(health.reason).toMatch(/onRawEvent/);
  });

  it('does not hook when disabled or when the command is empty', () => {
    const { channel, handlers } = fakeChannel();
    const disabled = hook({ channel, config: cfg({ enabled: false }) }).hook.attach();
    expect(disabled.hooked).toBe(false);
    expect(disabled.reason).toMatch(/未启用/);

    const noCommand = hook({ channel, config: cfg({ command: [] }) }).hook.attach();
    expect(noCommand.hooked).toBe(false);
    expect(noCommand.reason).toMatch(/command/);
    expect(handlers.size).toBe(0);
  });

  it('unsubscribes and clears pending runs on dispose', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel });
    h.attach();
    expect(handlers.size).toBe(2);

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1', note_token: 't1' });
    h.dispose();
    expect(handlers.size).toBe(0);
    expect(h.healthState().hooked).toBe(false);

    vi.runAllTimers();
    expect(run).not.toHaveBeenCalled();
  });
});

describe('NotesSyncHook runs', () => {
  it('runs the command after delayMs, then again at each retry delay', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1', note_token: 'tok-1' });
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toEqual(['/usr/bin/python3', '/tmp/sync.py']);

    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(30_000);
    expect(run).toHaveBeenCalledTimes(3);

    expect(h.healthState()).toMatchObject({ received: 1, runs: 3 });
    expect(h.healthState().lastRunAt).toBeTruthy();
  });

  it('treats the minute-generated push as a trigger too', () => {
    // A 妙记 lands about a second before its 「我的笔记」 document and is the event
    // this app reliably receives; the command lists the drive itself, so either
    // push may start it.
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel });
    h.attach();

    handlers.get(MINUTES_GENERATED_EVENT)?.({ event_id: 'm1', minute_token: 'min-1' });
    vi.advanceTimersByTime(1000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.healthState().received).toBe(1);
  });

  it('counts a push and schedules nothing when disabled at fire time', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run, ref } = hook({ channel });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1', note_token: 'tok-1' });
    ref.current = cfg({ enabled: false });
    vi.runAllTimers();

    expect(run).not.toHaveBeenCalled();
    expect(h.healthState().received).toBe(1);
  });

  it('dedups redelivered event_ids (at-least-once delivery)', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel });
    h.attach();

    const payload = { event_id: 'same-event', note_token: 'tok-1' };
    handlers.get(NOTES_GENERATED_EVENT)?.(payload);
    handlers.get(NOTES_GENERATED_EVENT)?.({ ...payload });
    vi.runAllTimers();

    // One push scheduled (first run + two retries), the duplicate scheduled none.
    expect(run).toHaveBeenCalledTimes(3);
    expect(h.healthState().received).toBe(2);
  });

  it('treats distinct events as distinct work', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel, config: cfg({ retryDelaysMs: [] }) });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1', note_token: 'tok-1' });
    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e2', note_token: 'tok-2' });
    vi.runAllTimers();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('still runs on a payload without event_id or note_token', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel, config: cfg({ retryDelaysMs: [] }) });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({});
    vi.runAllTimers();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reads the live command at fire time, so /config edits apply', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run, ref } = hook({ channel });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1' });
    ref.current = cfg({ command: ['/bin/echo', 'next'], retryDelaysMs: [] });
    vi.runAllTimers();

    expect(run.mock.calls[0]?.[0]).toEqual(['/bin/echo', 'next']);
  });

  it('passes the bridge-bound env to every run', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const ref = { current: cfg({ retryDelaysMs: [] }) };
    const run = vi.fn();
    const env = { LARK_CHANNEL: '1', LARK_CHANNEL_PROFILE: 'pi' };
    const h = new NotesSyncHook({ channel, config: () => ref.current, run, env });
    h.attach();

    handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: 'e1' });
    vi.runAllTimers();

    expect(run.mock.calls[0]?.[1]).toEqual(env);
  });

  it('schedules each event in a burst independently', () => {
    vi.useFakeTimers();
    const { channel, handlers } = fakeChannel();
    const { hook: h, run } = hook({ channel, config: cfg({ retryDelaysMs: [] }) });
    h.attach();

    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5']) {
      handlers.get(NOTES_GENERATED_EVENT)?.({ event_id: id, note_token: `tok-${id}` });
    }
    vi.runAllTimers();

    expect(run).toHaveBeenCalledTimes(5);
    expect(h.healthState()).toMatchObject({ received: 5, runs: 5 });
  });
});

describe('spawnNotesCommand', () => {
  it('spawns argv with the merged bridge env and survives child errors', () => {
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill?: () => void };
    child.stderr = new EventEmitter();
    vi.mocked(spawnProcess).mockReturnValue(child as never);

    spawnNotesCommand(['/opt/homebrew/bin/python3', '/tmp/sync.py'], {
      LARK_CHANNEL: '1',
    });

    expect(spawnProcess).toHaveBeenCalledWith('/opt/homebrew/bin/python3', ['/tmp/sync.py'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: expect.objectContaining({ LARK_CHANNEL: '1' }),
    });

    // A failed child must surface as a log line, never as a throw.
    expect(() => {
      child.emit('error', new Error('spawn ENOENT'));
      child.stderr.emit('data', 'lark-cli: not bound');
      child.emit('close', 1);
    }).not.toThrow();
  });
});
