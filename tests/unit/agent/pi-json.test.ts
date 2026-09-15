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
    expect(
      t.translate({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } }),
    ).toEqual([{ type: 'text', delta: 'hi' }]);
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
    ).toEqual([{ type: 'text', delta: 'recovered' }]);
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
