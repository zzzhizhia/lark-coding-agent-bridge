import type { AgentEvent } from '../types';

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeRawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  cwd?: string;
  model?: string;
  message?: { content?: ContentBlock[] };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  total_cost_usd?: number;
}

/**
 * Translates claude's stream-json into bridge events.
 *
 * The last assistant message of a turn is the answer, and it is held back
 * instead of streamed: the answer goes out as its own message (see
 * `deliverFinalAnswer` in bot/channel), never as the tail of the process card.
 * Text that turns out to be commentary is released as soon as the run moves on —
 * a tool call in the same message, or another assistant message.
 */
export class ClaudeStreamTranslator {
  private pendingText = '';

  translate(raw: unknown): AgentEvent[] {
    if (!raw || typeof raw !== 'object') return [];
    const evt = raw as ClaudeRawEvent;

    if (evt.type === 'system' && evt.subtype === 'init') {
      return [
        {
          type: 'system',
          sessionId: evt.session_id,
          cwd: evt.cwd,
          model: evt.model,
        },
      ];
    }

    if (evt.type === 'assistant' && evt.message?.content) {
      return this.translateAssistant(evt.message.content);
    }

    if (evt.type === 'user' && evt.message?.content) {
      const events: AgentEvent[] = [];
      for (const block of evt.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const output =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          events.push({
            type: 'tool_result',
            id: block.tool_use_id,
            output,
            isError: block.is_error === true,
          });
        }
      }
      return events;
    }

    if (evt.type === 'result') {
      const answer = this.takePendingText();
      const events: AgentEvent[] = [];
      if (answer) events.push({ type: 'final_text', content: answer });
      if (evt.usage) {
        events.push({
          type: 'usage',
          inputTokens: evt.usage.input_tokens,
          outputTokens: evt.usage.output_tokens,
          cachedInputTokens: evt.usage.cache_read_input_tokens,
          costUsd: evt.total_cost_usd,
        });
      }
      events.push({ type: 'done', sessionId: evt.session_id, terminationReason: 'normal' });
      return events;
    }

    return [];
  }

  /** Text left held when the run ends without a `result` event. */
  finish(): AgentEvent[] {
    const answer = this.takePendingText();
    return answer ? [{ type: 'final_text', content: answer }] : [];
  }

  private translateAssistant(blocks: ContentBlock[]): AgentEvent[] {
    const callsTool = blocks.some(
      (block) => block.type === 'tool_use' && block.id && block.name,
    );
    const writesText = blocks.some((block) => block.type === 'text' && block.text);
    const events: AgentEvent[] = [];
    // Text in a message that calls a tool is commentary, and so is a message that
    // was followed by another one: neither is the answer.
    if (callsTool || writesText) events.push(...this.releasePendingText());

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        if (callsTool) events.push({ type: 'text', delta: block.text });
        else this.pendingText = block.text;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        events.push({ type: 'thinking', delta: block.thinking });
      } else if (block.type === 'tool_use' && block.id && block.name) {
        events.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return events;
  }

  /** Hand the held text to the process card as commentary. */
  private releasePendingText(): AgentEvent[] {
    const text = this.takePendingText();
    return text ? [{ type: 'text', delta: text }] : [];
  }

  private takePendingText(): string {
    const text = this.pendingText;
    this.pendingText = '';
    return text;
  }
}
