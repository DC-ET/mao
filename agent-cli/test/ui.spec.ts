import { describe, expect, it } from 'vitest';
import { parseKey } from '../src/ui/keys';
import { PromptQueue } from '../src/ui/prompt-queue';
import { formatRelativeTime } from '../src/ui/relative-time';
import { formatHistorySummary, formatSessionBanner } from '../src/ui/welcome';
import { completeSlash } from '../src/ui/slash-complete';
import { formatTodoSummary } from '../src/ui/todo-summary';
import { countRewindRows, countVisualRows, createAnsi, renderMarkdownLite } from '../src/util/ansi';

describe('parseKey', () => {
  it('parses arrows, enter, esc, digits', () => {
    expect(parseKey('\u001b[A').name).toBe('up');
    expect(parseKey('\u001b[B').name).toBe('down');
    expect(parseKey('\r').name).toBe('enter');
    expect(parseKey('\u001b').name).toBe('esc');
    expect(parseKey('3')).toEqual({ name: 'digit', digit: 3, raw: '3' });
    expect(parseKey('\t').name).toBe('tab');
    expect(parseKey('\u0003').name).toBe('ctrl-c');
  });
});

describe('PromptQueue', () => {
  it('pushes, lists and clears', () => {
    const q = new PromptQueue();
    expect(q.push('  hello  ')).toBe(1);
    expect(q.push('')).toBe(1);
    q.push('next');
    expect(q.list()).toEqual(['hello', 'next']);
    expect(q.shift()).toBe('hello');
    q.clear();
    expect(q.length).toBe(0);
  });
});

describe('formatRelativeTime', () => {
  it('uses friendly buckets', () => {
    const now = Date.parse('2026-08-20T16:00:00Z');
    expect(formatRelativeTime('2026-08-20T15:59:50Z', now)).toBe('刚刚');
    expect(formatRelativeTime('2026-08-20T15:50:00Z', now)).toBe('10 分钟前');
    expect(formatRelativeTime('2026-08-20T14:00:00Z', now)).toBe('2 小时前');
  });
});

describe('welcome / history', () => {
  it('formats session banner', () => {
    const line = formatSessionBanner({
      id: 128,
      agentName: '通用助手',
      modelName: 'gpt-4o',
      executionMode: 'CLOUD',
    });
    expect(line).toContain('#128');
    expect(line).toContain('通用助手');
    expect(line).toContain('CLOUD');
  });

  it('summarizes history with tool counts', () => {
    const lines = formatHistorySummary([
      { role: 'user', content: '帮我改登录页\n第二行' },
      { role: 'assistant', content: '已改 TopNav', toolCalls: [{ name: 'edit_file' }, { name: 'edit_file' }] },
    ], false);
    expect(lines[0]).toMatch(/你\s+帮我改登录页/);
    expect(lines[1]).toContain('Agent');
    expect(lines[1]).toContain('edit_file×2');
  });
});

describe('completeSlash', () => {
  it('completes command names', () => {
    const [hits, prefix] = completeSlash('/mo');
    expect(prefix).toBe('/mo');
    expect(hits).toContain('/model ');
  });

  it('completes model names after /model', () => {
    const [hits, prefix] = completeSlash('/model gp', { models: ['gpt-4o', 'mimo'] });
    expect(prefix).toBe('gp');
    expect(hits).toEqual(['gpt-4o']);
  });

  it('completes /queue clear', () => {
    const [hits] = completeSlash('/queue c');
    expect(hits).toEqual(['clear']);
  });
});

describe('formatTodoSummary', () => {
  it('counts completed items', () => {
    expect(formatTodoSummary([])).toBeUndefined();
    expect(formatTodoSummary([
      { status: 'completed' },
      { status: 'pending' },
      { status: 'in_progress' },
    ])).toBe('Todo 1/3');
  });
});

describe('visual rows / markdown lite', () => {
  it('counts rewind rows for partial vs complete lines', () => {
    expect(countVisualRows('hello', 80)).toBe(1);
    expect(countRewindRows('hello', 80)).toBe(0);
    expect(countRewindRows('hello\n', 80)).toBe(1);
    expect(countVisualRows('a'.repeat(20), 10)).toBe(2);
  });

  it('does not transform partial markdown mid-line', () => {
    const ansi = createAnsi(true);
    expect(renderMarkdownLite('**ab', ansi)).toBe('**ab');
    expect(renderMarkdownLite('**ab**', ansi)).toContain('\x1b[1mab\x1b[0m');
  });
});
