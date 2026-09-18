import { describe, expect, it } from 'vitest';
import { PiJsonTranslator } from '../../../src/agent/pi/json.js';

const htmlError = [
  '503 <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">',
  '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD>',
  "<BODY><H1>503 Service Unavailable</H1><H2>The request could not be satisfied.</H2></BODY></HTML>",
].join('\n');

describe('Pi JSON translator', () => {
  it('translates session, tool and assistant text events', () => {
    const t = new PiJsonTranslator();

    expect(t.translate({ type: 'session', id: 'sess-1', cwd: '/w' })).toEqual([
      { type: 'system', sessionId: 'sess-1', cwd: '/w' },
    ]);
    expect(
      t.translate({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
    ).toEqual([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }]);
    expect(t.translate({ type: 'tool_execution_end', toolCallId: 't1', result: { ok: true }, isError: false })).toEqual([
      { type: 'tool_result', id: 't1', output: '{"ok":true}', isError: false },
    ]);
    // Streamed text is held: the last message of a turn is the answer, and the
    // answer is delivered as its own message rather than as the card's tail.
    expect(
      t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }),
    ).toEqual([]);
  });

  it('does not take the user prompt as the answer', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });

    // pi reports the user's prompt over the same stream it reports the answer on
    // (`message_start` / `message_end` carry the role). Seeding the answer from
    // it turned `final_text` into the bridge's own system prompt followed by the
    // reply — which is exactly what got posted back at the user.
    const prompt = 'BRIDGE_SYSTEM_PROMPT\n\n<user_input>hi</user_input>';
    t.translate({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    t.translate({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'the answer' } });

    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'the answer' }] }],
      }),
    ).toEqual([
      { type: 'final_text', content: 'the answer' },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
  });

  it('seeds the answer from an assistant message that never streamed deltas', () => {
    const t = new PiJsonTranslator();

    t.translate({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'whole answer at once' }] },
    });

    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      }),
    ).toEqual([
      { type: 'final_text', content: 'whole answer at once' },
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });

  it('ignores tool results reported over the message channel', () => {
    const t = new PiJsonTranslator();

    t.translate({
      type: 'message_end',
      message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'file contents' }] },
    });

    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      }),
    ).toEqual([{ type: 'done', sessionId: undefined, terminationReason: 'normal' }]);
  });

  it('completes normally when the run ends without an error', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });
    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'done' } });

    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }],
      }),
    ).toEqual([
      { type: 'final_text', content: 'done' },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('holds the answer back until the turn ends', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });

    expect(
      t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'the ' } }),
    ).toEqual([]);
    expect(
      t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } }),
    ).toEqual([]);
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'the answer' }] }],
      }),
    ).toEqual([
      { type: 'final_text', content: 'the answer' },
      { type: 'done', sessionId: 'sess-1', terminationReason: 'normal' },
    ]);
  });

  it('releases text as commentary once a tool call follows', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'let me check' } });

    expect(
      t.translate({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } }),
    ).toEqual([
      { type: 'text', delta: 'let me check' },
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
    ]);

    // Commentary stays commentary: the turn ends without an answer of its own.
    t.translate({ type: 'tool_execution_end', toolCallId: 't1', result: 'ok', isError: false });
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [] }],
      }),
    ).toEqual([{ type: 'done', sessionId: undefined, terminationReason: 'normal' }]);
  });

  it('hands the previous message over as commentary when another one starts', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'first' } });

    expect(t.translate({ type: 'message_start', message: { role: 'assistant', content: [] } })).toEqual([
      { type: 'text', delta: 'first' },
    ]);

    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'second' } });
    expect(
      t.translate({ type: 'agent_end', willRetry: false, messages: [] }),
    ).toEqual([
      { type: 'final_text', content: 'second' },
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });

  it('reports a failure when the last assistant message ended with stopReason=error', () => {
    const t = new PiJsonTranslator();

    const events = t.translate({
      type: 'agent_end',
      willRetry: false,
      messages: [
        { role: 'assistant', stopReason: 'toolUse', content: [] },
        { role: 'toolResult', content: [] },
        { role: 'assistant', stopReason: 'error', errorMessage: htmlError, content: [] },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', terminationReason: 'failed' });
    const message = (events[0] as { message: string }).message;
    expect(message).toContain('503 Service Unavailable');
    expect(message).not.toContain('<');
    expect(message.length).toBeLessThanOrEqual(300);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('reports a failure once the retry budget is exhausted', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });

    // Attempt 1 fails but pi schedules an internal retry…
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: true,
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '503 first', content: [] }],
      }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);

    // …the retry fails too and pi gives up: this one ends the run as failed.
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: '503 second', content: [] }],
      }),
    ).toEqual([{ type: 'error', message: '503 second', terminationReason: 'failed' }]);
    expect(t.terminalEmitted()).toBe(true);
  });

  it('ignores an earlier failed assistant message when the run recovered', () => {
    const t = new PiJsonTranslator();

    expect(
      t.translate({
        type: 'agent_end',
        messages: [
          { role: 'assistant', stopReason: 'error', errorMessage: '503', content: [] },
          { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] },
        ],
      }),
    ).toEqual([{ type: 'done', sessionId: undefined, terminationReason: 'normal' }]);
  });

  it('does not report a user-initiated abort as a failure', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'session', id: 'sess-1' });

    // `aborted` is what pi reports after the bridge stops the run; the bridge
    // owns the "interrupted" card state, so this must stay a normal end.
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'aborted', errorMessage: 'aborted by user', content: [] }],
      }),
    ).toEqual([{ type: 'done', sessionId: 'sess-1', terminationReason: 'normal' }]);
  });

  it('keeps partial output and truncates long error bodies', () => {
    const t = new PiJsonTranslator();
    t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial answer' } });

    const events = t.translate({
      type: 'agent_end',
      messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'x'.repeat(500), content: [] }],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'final_text', content: 'partial answer' });
    expect(events[1]).toMatchObject({ type: 'error' });
    const message = (events[1] as { message: string }).message;
    expect(message.endsWith('…')).toBe(true);
    expect(message.length).toBe(300);
  });

  it('falls back to a generic message when the error carries no detail', () => {
    const t = new PiJsonTranslator();
    expect(
      t.translate({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'error', content: [] }] }),
    ).toEqual([{ type: 'error', message: 'pi reported an error', terminationReason: 'failed' }]);
  });

  it('does not end the run when pi is about to retry internally', () => {
    const t = new PiJsonTranslator();

    expect(
      t.translate({
        type: 'agent_end',
        willRetry: true,
        messages: [{ role: 'assistant', stopReason: 'error', errorMessage: htmlError, content: [] }],
      }),
    ).toEqual([]);
    expect(t.terminalEmitted()).toBe(false);

    // The retry keeps streaming into the same run.
    expect(
      t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } }),
    ).toEqual([]);
    expect(
      t.translate({
        type: 'agent_end',
        willRetry: false,
        messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered' }] }],
      }),
    ).toEqual([
      { type: 'final_text', content: 'recovered' },
      { type: 'done', sessionId: undefined, terminationReason: 'normal' },
    ]);
  });
});
