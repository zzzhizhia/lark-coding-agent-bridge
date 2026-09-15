import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });

  it('finalizes the card with the failure note when the agent reports an error', () => {
    // This is the card the user sees when the pi translator surfaces a model
    // request failure (e.g. an upstream 503) instead of a silent "done".
    const state = reduce(initialState, {
      type: 'error',
      message: '503 Service Unavailable The request could not be satisfied',
      terminationReason: 'failed',
    });

    const card = JSON.stringify(renderCard(state));
    expect(state.footer).toBeNull();
    expect(card).toContain('⚠️ agent 失败：503 Service Unavailable');
    expect(card).not.toContain('正在调用工具');
  });
});
