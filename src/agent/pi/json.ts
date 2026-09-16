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
        // pi reports every message of the turn over the same channel, the user's
        // prompt included. Only the assistant's own text is an answer: seeding
        // `assistantText` from the prompt made `final_text` start with the
        // bridge's system prompt (and the user's message) followed by the reply.
        if (!message || message.role !== 'assistant') return [];
        const content = textFromContent(message.content);
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
      case 'agent_end': {
        // pi retries transient failures (429/5xx, stream drops) internally and
        // announces the retry with `willRetry: true` before continuing with the
        // same run. Do not treat that as the end of the run.
        if (raw.willRetry === true) return [];
        this.terminal = true;
        // pi ends the run with a normal `agent_end` even when the model request
        // failed, so the failure has to be read off the last assistant message.
        const failure = lastAssistantFailure(raw.messages);
        if (failure) {
          return [
            ...(this.assistantText ? [{ type: 'final_text' as const, content: this.assistantText }] : []),
            { type: 'error', message: failure, terminationReason: 'failed' },
          ];
        }
        return [
          ...(this.assistantText ? [{ type: 'final_text' as const, content: this.assistantText }] : []),
          { type: 'done', sessionId: this.sessionId, terminationReason: 'normal' },
        ];
      }
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
/**
 * Returns a human-readable message when the run ended because the model request
 * failed. `messages` is the `agent_end` payload; the last assistant message is
 * the one that terminated the run.
 */
function lastAssistantFailure(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = recordValue(messages[i]);
    if (!message || message.role !== 'assistant') continue;
    if (message.stopReason !== 'error') return undefined;
    return errorSummary(stringValue(message.errorMessage)) ?? 'pi reported an error';
  }
  return undefined;
}

/**
 * Provider errors often arrive as an HTML error page (e.g. a CloudFront 503).
 * Strip the markup, collapse whitespace and keep the card note short.
 */
function errorSummary(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = stripped || raw.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function renderResult(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value ?? '') ?? ''; } catch { return String(value); }
}
