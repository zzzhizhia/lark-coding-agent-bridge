import { describe, expect, it } from 'vitest';
import { initialState, type Block, type RunState } from '../../../src/card/run-state.js';
import { renderText, renderTextFrom } from '../../../src/card/text-renderer.js';

function state(blocks: Block[], extra: Partial<RunState> = {}): RunState {
  return { ...initialState, blocks, ...extra };
}

function text(content: string, streaming = false): Block {
  return { kind: 'text', content, streaming };
}

function tool(id: string, name: string): Block {
  return { kind: 'tool', tool: { id, name, input: {}, status: 'done' } };
}

describe('renderTextFrom', () => {
  it('renders the whole state from the first block', () => {
    const s = state([text('first'), text('second')], {
      footer: null,
      terminal: 'done',
    });
    expect(renderTextFrom(s, 0)).toBe(renderText(s));
  });

  it('drops the blocks an earlier card already showed', () => {
    const s = state([text('first'), tool('t1', 'bash'), text('last')], {
      footer: null,
      terminal: 'done',
    });
    expect(renderTextFrom(s, 2)).toBe('last');
  });

  it('keeps the running footer on a continuation card', () => {
    const s = state([text('first'), text('second')], {
      footer: 'thinking',
      terminal: 'running',
    });
    expect(renderTextFrom(s, 1)).toBe('second\n\n_🧠 正在思考…_');
  });

  it('renders only the footer when everything is already on earlier cards', () => {
    const s = state([text('only')], { footer: 'tool_running', terminal: 'running' });
    expect(renderTextFrom(s, 1)).toBe('_🧰 正在调用工具…_');
  });

  it('keeps the terminal notice on a continuation card', () => {
    const s = state([text('first'), text('second')], {
      footer: null,
      terminal: 'interrupted',
    });
    expect(renderTextFrom(s, 1)).toBe('second\n\n_⏹ 已被中断_');
  });
});
