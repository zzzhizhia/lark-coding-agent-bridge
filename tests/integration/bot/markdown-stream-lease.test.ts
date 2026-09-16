import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import {
  createFakeLarkChannel,
  type FakeLarkChannel,
  type StreamFn,
} from '../../helpers/fake-lark-channel.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('markdown progress stream lease', () => {
  it('continues on a fresh card when the run outlives the lease', async () => {
    // Feishu stops accepting updates ten minutes after it enabled a card's
    // streaming mode. A run longer than that used to freeze mid-sentence; it now
    // continues on a new card, and the answer still lands on a live one.
    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', '600');
    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '300');
    const { cards, stream } = recordingStream();
    const channel = (await startTestBridge(
      new PacedAgent([
        { type: 'text', delta: 'PROGRESS_ONE' },
        { type: 'tool_use', id: 't1', name: 'bash', input: {} },
        { type: 'tool_result', id: 't1', output: 'ok', isError: false },
        350,
        { type: 'text', delta: 'ANSWER_SENTINEL' },
        { type: 'final_text', content: 'ANSWER_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      stream,
    ));

    await channel.handlers.message?.(message('om_lease', 'run'));

    await waitFor(() => cards.length === 2 && lastText(cards).includes('ANSWER_SENTINEL'));
    expect(cards[0]?.texts[0]).toContain('PROGRESS_ONE');
    // The continuation starts where the previous card stopped.
    expect(lastText(cards)).not.toContain('PROGRESS_ONE');
    // Delivered on a live card, so nothing is posted alongside it.
    await settle();
    expect(channel.sent).toHaveLength(0);
  });

  it('ignores an adapter whose final text repeats the prompt it was given', async () => {
    // pi reports the user's prompt over its own event stream. A bridge that
    // trusted `final_text` verbatim would read "system prompt + answer" as the
    // answer, never find it on the card, and post the prompt back at the user.
    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', '600');
    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '300');
    const { cards, stream } = recordingStream();
    const channel = (await startTestBridge(
      new PacedAgent([
        { type: 'text', delta: 'ANSWER_SENTINEL' },
        {
          type: 'final_text',
          content: 'BRIDGE_SYSTEM_PROMPT\n\n<user_input>run</user_input>\n\nANSWER_SENTINEL',
        },
        { type: 'done', terminationReason: 'normal' },
      ]),
      stream,
    ));

    await channel.handlers.message?.(message('om_prompt_echo', 'run'));

    await waitFor(() => lastText(cards).includes('ANSWER_SENTINEL'));
    await settle();
    expect(cards).toHaveLength(1);
    expect(channel.sent).toHaveLength(0);
  });

  it('posts the answer on its own when Feishu dropped it', async () => {
    // Rotation off: the only card ages out, Feishu keeps accepting the updates
    // and drops them, and nothing throws. The answer never reached the screen,
    // so it has to be delivered as its own message.
    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', '300');
    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '0');
    const { cards, stream } = recordingStream();
    const channel = (await startTestBridge(
      new PacedAgent([
        { type: 'text', delta: 'PROGRESS_ONE' },
        400,
        { type: 'text', delta: 'ANSWER_SENTINEL' },
        { type: 'final_text', content: 'ANSWER_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      stream,
    ));

    await channel.handlers.message?.(message('om_lost', 'run'));

    await waitFor(() => channel.sent.length === 1);
    expect(cards).toHaveLength(1);
    expect(lastMarkdown(channel)).toContain('ANSWER_SENTINEL');
    expect(lastMarkdown(channel)).toContain('流式更新已停止');
  });

  it('leaves a healthy short run alone', async () => {
    vi.stubEnv('LARK_CHANNEL_STREAM_LEASE_MS', '600');
    vi.stubEnv('LARK_CHANNEL_STREAM_ROTATE_MS', '300');
    const { cards, stream } = recordingStream();
    const channel = (await startTestBridge(
      new PacedAgent([
        { type: 'text', delta: 'ANSWER_SENTINEL' },
        { type: 'final_text', content: 'ANSWER_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ]),
      stream,
    ));

    await channel.handlers.message?.(message('om_short', 'run'));

    await waitFor(() => lastText(cards).includes('ANSWER_SENTINEL'));
    await settle();
    expect(cards).toHaveLength(1);
    expect(channel.sent).toHaveLength(0);
  });
});

/** An agent that plays its events on a timer, so a run can outlive a lease. */
class PacedAgent implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude (paced)';

  constructor(private readonly script: ReadonlyArray<AgentEvent | number>) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  run(opts: AgentRunOptions): AgentRun {
    const script = this.script;
    async function* events(): AsyncIterable<AgentEvent> {
      for (const step of script) {
        if (typeof step === 'number') {
          await new Promise((resolve) => setTimeout(resolve, step));
          continue;
        }
        yield step;
      }
    }
    return {
      runId: opts.runId,
      events: events(),
      stop: async () => {},
      waitForExit: async () => true,
    };
  }
}

/** Stands in for `channel.stream`: one record per progress card. */
function recordingStream(): { cards: Array<{ texts: string[] }>; stream: StreamFn } {
  const cards: Array<{ texts: string[] }> = [];
  const stream: StreamFn = async (_chatId, input) => {
    const producer = (
      input as {
        markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
      }
    ).markdown;
    const record = { texts: [] as string[] };
    cards.push(record);
    await producer?.({
      setContent: async (markdown: string) => {
        record.texts.push(markdown);
      },
    });
  };
  return { cards, stream };
}

async function startTestBridge(agent: AgentAdapter, stream: StreamFn): Promise<FakeLarkChannel> {
  const tmp = await createTmpProfile('markdown-stream-lease-');
  const workspace = await realpath(tmp.workspace);
  const channel = createFakeLarkChannel({ stream });
  sdkMock.channel = channel;

  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: { allowedUsers: ['ou_user'] },
    preferences: { messageReply: 'markdown' },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));

  const bridge = await startChannel({
    cfg: profileConfig,
    agent,
    sessions,
    workspaces,
    controls: {
      profile: 'claude',
      profileConfig,
      ownerRefreshState: 'unknown' as const,
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: '/tmp/config.json',
      cfg: profileConfig,
      processId: 'proc_test',
    },
  });

  cleanups.push(async () => {
    await bridge.disconnect();
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return channel;
}

function lastText(cards: Array<{ texts: string[] }>): string {
  return cards.at(-1)?.texts.at(-1) ?? '';
}

function message(messageId: string, content: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentionedBot: false,
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 120));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
