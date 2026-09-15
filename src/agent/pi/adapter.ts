import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { log } from '../../core/logger';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { PiJsonTranslator } from './json';

export interface PiAdapterOptions {
  binary?: string;
  larkChannel?: LarkChannelEnvContext;
  stopGraceMs?: number;
}

type PiChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi';
  readonly displayName = 'Pi';
  private readonly binary: string;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly defaultStopGraceMs: number;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: PiAdapterOptions = {}) {
    this.binary = opts.binary ?? process.env.LARK_CHANNEL_PI_BIN ?? 'pi';
    this.larkChannel = opts.larkChannel;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
  }
  setBotIdentity(identity: AgentBotIdentity): void { this.botIdentity = identity; }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({ agentId: 'pi', agentName: 'Pi', command: this.binary, binaryPath: this.binary });
  }
  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) throw new SpawnFailed('pi binary check failed', availability.error, availability.diagnostic.code, availability.diagnostic);
  }
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for PiAdapter.run');
    const args = ['--mode', 'json', ...(opts.sessionId ? ['--session', opts.sessionId] : []), ...(opts.model ? ['--model', opts.model] : []), prefixBridgeSystemPrompt(opts.prompt, this.botIdentity)];
    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, buildLarkChannelEnv(this.larkChannel)),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as PiChild;
    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    let stopRequested = false;
    child.stderr.on('data', (chunk: Buffer) => { stderrChunks.push(chunk); });
    child.on('error', (err) => { runtimeError = err; });
    child.on('exit', (code, signal) => log.info('agent', 'exit', { agent: 'pi', pid: child.pid ?? null, code, signal }));
    child.stdin.on('error', (err) => log.warn('agent', 'stdin-error', { agent: 'pi', message: err.message }));
    child.stdin.end();
    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;
    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError, () => stopRequested),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        stopRequested = true;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve(); }, stopGraceMs);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise((resolve) => {
          const onExit = () => { clearTimeout(timer); resolve(true); };
          const timer = setTimeout(() => { child.removeListener('exit', onExit); resolve(false); }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(child: PiChild, stderrChunks: Buffer[], getError: () => Error | null, wasStopped: () => boolean): AsyncGenerator<AgentEvent> {
  const translator = new PiJsonTranslator();
  if (!child.pid) { yield* translator.fail(getError() ? `failed to spawn pi: ${getError()!.message}` : 'spawn returned no pid'); return; }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { yield* translator.translate(JSON.parse(line)); } catch { /* Ignore non-JSON diagnostics. */ }
    }
  } finally { rl.close(); }
  const code = await waitForExitCode(child);
  const error = getError();
  if (wasStopped()) yield* translator.finish('interrupted');
  else if (code !== 0 && code !== null && !translator.terminalEmitted()) {
    const detail = Buffer.concat(stderrChunks).toString('utf8').trim();
    yield* translator.fail(`pi exited with code ${code}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
  } else if (error) yield* translator.fail(`pi runtime error: ${error.message}`);
  else yield* translator.finish();
}
async function waitForExitCode(child: PiChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}
