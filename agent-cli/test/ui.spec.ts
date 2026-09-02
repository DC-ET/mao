import { describe, expect, it } from 'vitest';
import { PromptQueue } from '../src/ui/prompt-queue';
import { formatRelativeTime } from '../src/ui/relative-time';
import { formatHistorySummary, formatSessionBanner } from '../src/ui/welcome';
import { completeSlash, findSlashItem, formatSlashHelp, slashPalette, SLASH_ITEMS } from '../src/ui/slash-complete';
import { formatTodoSummary } from '../src/ui/todo-summary';
import { summarizeToolArgs, truncate } from '../src/ui/tool-format';
import { displayWidth, truncateToWidth } from '../src/ui/width';
import { consumeMarkdownLines, classifyMdLine, splitInline } from '../src/tui/markdown-parse';

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

describe('slash commands', () => {
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

  it('lists commands when typing /', () => {
    const picks = slashPalette('/');
    expect(picks.some((p) => p.label === '/help')).toBe(true);
    expect(picks.find((p) => p.label === '/model')?.submit).toBe(false);
    expect(picks.find((p) => p.label === '/help')?.submit).toBe(true);
  });

  it('filters by prefix and offers models', () => {
    expect(slashPalette('/he').map((p) => p.label)).toEqual(['/help']);
    const models = slashPalette('/model ', { models: ['gpt-4o', 'mimo'] });
    expect(models[0]).toMatchObject({ value: '/model', submit: true });
    expect(models.map((p) => p.label)).toContain('gpt-4o');
    expect(slashPalette('/model gp', { models: ['gpt-4o', 'mimo'] }).map((p) => p.value)).toEqual(['/model gpt-4o']);
  });

  it('findSlashItem only matches known commands', () => {
    expect(findSlashItem('help')?.cmd).toBe('help');
    expect(findSlashItem('thinking')?.cmd).toBe('thinking');
    expect(findSlashItem('nope')).toBeUndefined();
  });

  it('/help lists every command from the single source of truth', () => {
    const help = formatSlashHelp();
    for (const item of SLASH_ITEMS) {
      expect(help).toContain(`/${item.cmd}`);
    }
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

describe('width helpers', () => {
  it('counts CJK as two columns and truncates by width', () => {
    expect(displayWidth('中文abc')).toBe(7);
    expect(displayWidth('\x1b[1mabc\x1b[0m')).toBe(3);
    expect(truncateToWidth('中文中文', 5)).toBe('中文…');
  });
});

describe('markdown-parse', () => {
  it('classifies headings, lists, fences and tables', () => {
    const lines = consumeMarkdownLines('# Title\n- item `x`\n| a | b |\n```\ncode\n```\n');
    expect(lines.map((l) => l.kind)).toEqual(['heading', 'list', 'table', 'fence', 'code', 'fence', 'empty']);
    expect(lines[0].text).toBe('Title');
    expect(lines[0].level).toBe(1);
  });

  it('classifyMdLine keeps fence state with the caller', () => {
    const open = classifyMdLine('```ts', false);
    expect(open.inFence).toBe(true);
    expect(open.line.kind).toBe('fence');
    const inside = classifyMdLine('# not a heading', open.inFence);
    expect(inside.line.kind).toBe('code');
    expect(classifyMdLine('```', inside.inFence).inFence).toBe(false);
  });

  it('recognises ordered lists', () => {
    expect(classifyMdLine('1. first', false).line.kind).toBe('list');
    expect(classifyMdLine('2) second', false).line.kind).toBe('list');
  });

  it('splits bold and inline code', () => {
    expect(splitInline('a **b** and `c`')).toEqual([
      { style: 'plain', text: 'a ' },
      { style: 'bold', text: 'b' },
      { style: 'plain', text: ' and ' },
      { style: 'code', text: 'c' },
    ]);
  });
});

describe('tool formatting', () => {
  it('summarizes json tool args', () => {
    expect(summarizeToolArgs('{"command":"ls -la"}')).toBe('ls -la');
    expect(summarizeToolArgs('{"path":"README.md"}')).toBe('README.md');
    expect(summarizeToolArgs('')).toBe('');
  });

  it('truncates by lines then chars', () => {
    expect(truncate('a\nb\nc', 100, 2)).toBe('a\nb\n…');
    expect(truncate('abcdef', 3, 10)).toBe('abc…');
  });
});
