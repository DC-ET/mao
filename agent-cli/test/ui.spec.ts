import { describe, expect, it } from 'vitest';
import { parseKey, parseKeys } from '../src/ui/keys';
import { PromptQueue } from '../src/ui/prompt-queue';
import { formatRelativeTime } from '../src/ui/relative-time';
import { formatHistorySummary, formatSessionBanner } from '../src/ui/welcome';
import { completeSlash } from '../src/ui/slash-complete';
import { formatTodoSummary } from '../src/ui/todo-summary';
import { formatToolStart, formatUserBlock, formatUserTurn, summarizeToolArgs } from '../src/ui/box';
import { Composer } from '../src/ui/composer';
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

  it('splits pasted / burst input into per-key events', () => {
    const keys = parseKeys('bbbbbb\r');
    expect(keys.filter((k) => k.name === 'char')).toHaveLength(6);
    expect(keys.at(-1)?.name).toBe('enter');
    const zh = parseKeys('队列成功\r');
    expect(zh.filter((k) => k.name === 'char').map((k) => k.raw).join('')).toBe('队列成功');
    expect(zh.at(-1)?.name).toBe('enter');
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
    expect(lines[0]).toMatch(/❯\s+帮我改登录页/);
    expect(lines[1]).toMatch(/⏺/);
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

describe('tool / user cards', () => {
  it('summarizes json tool args', () => {
    expect(summarizeToolArgs('{"command":"ls -la"}')).toBe('ls -la');
    expect(summarizeToolArgs('{"path":"README.md"}')).toBe('README.md');
  });

  it('formats user and tool lines', () => {
    expect(formatUserTurn('hello', {})).toBe('❯ hello');
    const block = formatUserBlock('hello', { cols: 20 });
    expect(block.trim()).toBe('hello');
    expect(block.length).toBe(20);
    expect(formatToolStart('shell', 'ls', {})).toContain('⏺ shell');
  });
});

describe('composer', () => {
  it('draws a boxed idle prompt', () => {
    const c = new Composer({
      write: () => undefined,
      rows: () => 24,
      columns: () => 40,
      dim: (s) => s,
      cyan: (s) => s,
      frames: ['⠋'],
      getMeta: () => '氛围编程 · CLOUD',
    });
    const lines = c.renderLines();
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[1]).toContain('→');
    expect(lines[1]).toContain('继续对话');
    expect(lines[2]).toMatch(/^╰─+╯$/);
    expect(lines[3]).toContain('氛围编程');
  });

  it('paints the box with DEC save/restore so transcript cursor is kept', () => {
    let out = '';
    const c = new Composer({
      write: (s) => { out += s; },
      rows: () => 24,
      columns: () => 40,
      dim: (s) => s,
      cyan: (s) => s,
      frames: ['⠋'],
      getMeta: () => 'meta',
    });
    expect(c.tryStart()).toBe(true);
    try {
      c.setIdle('hello');
      expect(out).toContain('\x1b[?1049h');
      expect(out).toContain('\x1b[2J');
      expect(out).toContain('\x1b7');
      expect(out).toContain('\x1b8');
      expect(out).not.toMatch(/\x1b\[s/);
      c.sealHeader(2);
      expect(out).toMatch(/\x1b\[3;\d+r/);
    } finally {
      c.stop();
    }
    expect(out).toContain('\x1b[?1049l');
  });
});
