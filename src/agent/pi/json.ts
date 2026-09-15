import type { AgentEvent } from '../types';

export class PiJsonTranslator {
  private sessionId: string | undefined;
  private terminal = false;
  private assistantText = '';
  private readonly tools = new Set<string>();

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal || !isRecord(raw) || typeof raw.type !== 'string') return [];
    switch (raw.type) {
      case 'session': {
        const id = stringValue(raw.id);
        if (!id) return [];
        this.sessionId = id;
        return [{ type: 'system', sessionId: id, cwd: stringValue(raw.cwd) }];
      }
      case 'message_update':
        return this.translateAssistantUpdate(recordValue(raw.assistantMessageEvent));
      case 'message_end': {
        const message = recordValue(raw.message);
        const content = message ? textFromContent(message.content) : '';
        if (content && !this.assistantText) this.assistantText = content;
        return [];
      }
      case 'tool_execution_start': {
        const id = stringValue(raw.toolCallId);
        const name = stringValue(raw.toolName);
        if (!id || !name) return [];
        this.tools.add(id);
        return [{ type: 'tool_use', id, name, input: raw.args ?? {} }];
      }
      case 'tool_execution_end': {
        const id = stringValue(raw.toolCallId);
        if (!id) return [];
        this.tools.delete(id);
        return [{
          type: 'tool_result',
          id,
          output: renderResult(raw.result),
          isError: raw.isError === true,
        }];
      }
      case 'agent_end':
        this.terminal = true;
        return [
          ...(this.assistantText ? [{ type: 'final_text' as const, content: this.assistantText }] : []),
          { type: 'done', sessionId: this.sessionId, terminationReason: 'normal' },
        ];
      case 'error':
        this.terminal = true;
        return [{ type: 'error', message: stringValue(raw.message) ?? 'pi reported an error', terminationReason: 'failed' }];
      default:
        return [];
    }
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  finish(reason: 'failed' | 'interrupted' | 'timeout' = 'failed'): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return reason === 'failed'
      ? [{ type: 'error', message: 'pi stream ended before agent_end', terminationReason: 'failed' }]
      : [{ type: 'done', sessionId: this.sessionId, terminationReason: reason }];
  }

  fail(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true;
    return [{ type: 'error', message, terminationReason: 'failed' }];
  }

  private translateAssistantUpdate(event: Record<string, unknown> | undefined): AgentEvent[] {
    if (!event) return [];
    const delta = stringValue(event.delta ?? event.content);
    if (!delta) return [];
    if (event.type === 'text_delta') {
      this.assistantText += delta;
      return [{ type: 'text', delta }];
    }
    if (event.type === 'thinking_delta') return [{ type: 'thinking', delta }];
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (!isRecord(part)) return '';
    return stringValue(part.text) ?? stringValue(part.content) ?? '';
  }).join('');
}
function renderResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? '') ?? ''; } catch { return String(value); }
}
