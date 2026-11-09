import { describe, expect, it } from 'vitest';
import { getToolDisplayName, getToolInputPreview, parseToolArgs, toolRowSummary } from './toolDisplay';
import { buildToolBodyView, prettyJsonOrRaw } from './toolViews';
import { formatElapsedMs, formatRoundDuration } from './elapsed';
import { buildEditDiff } from './toolDiff';

describe('toolDisplay 展示名与入参摘要', () => {
  it('内置工具映射中文名，未知工具原样返回', () => {
    expect(getToolDisplayName('shell')).toBe('执行命令');
    expect(getToolDisplayName('read_file')).toBe('读取文件');
    expect(getToolDisplayName('page_click')).toBe('点击页面元素');
    expect(getToolDisplayName('unknown_tool')).toBe('unknown_tool');
    // mcp 全量模式工具名还原为 server.tool
    expect(getToolDisplayName('mcp__svc__do_thing')).toBe('svc.do_thing');
  });

  it('入参摘要按工具取关键字段', () => {
    expect(getToolInputPreview('shell', { command: 'git status' })).toBe('git status');
    expect(getToolInputPreview('read_file', { path: 'a/b.json' })).toBe('a/b.json');
    expect(getToolInputPreview('web_search', { query: 'mao' })).toBe('mao');
    expect(getToolInputPreview('glob_search', { pattern: '*.ts', path: 'src' })).toBe('*.ts in src');
    expect(getToolInputPreview('page_click', { elementId: 'btn-1' })).toBe('元素: btn-1');
    // 长命令截断
    expect(getToolInputPreview('shell', { command: 'x'.repeat(80) })).toHaveLength(63);
    expect(getToolInputPreview('shell', {})).toBe('');
  });

  it('行头摘要：后端 summary 优先，缺省回退中文名 · 入参', () => {
    expect(toolRowSummary('后端摘要', 'shell', { command: 'ls' })).toBe('后端摘要');
    expect(toolRowSummary(undefined, 'shell', { command: 'ls' })).toBe('执行命令 · ls');
    expect(toolRowSummary(undefined, 'shell', null)).toBe('执行命令');
  });

  it('parseToolArgs：流式期未攒齐 JSON 返回 null，不抛错', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ a: 1 });
    expect(parseToolArgs('{"a"')).toBeNull();
    expect(parseToolArgs('')).toBeNull();
    expect(parseToolArgs('[1,2]')).toBeNull();
  });
});

describe('toolViews 富视图', () => {
  it('shell：命令 + 输出 + exit 徽标；错误走 error 位', () => {
    const ok = buildToolBodyView('shell', { command: 'git status' }, '{"output":"clean","exit_code":0}');
    expect(ok).toMatchObject({ kind: 'shell', primary: 'git status', output: 'clean', badge: { text: 'exit 0', ok: true } });
    const fail = buildToolBodyView('shell', { command: 'nope' }, '{"error":"command not found","exit_code":127}');
    expect(fail).toMatchObject({ kind: 'shell', error: 'command not found', badge: { text: 'exit 127', ok: false } });
    // write_stdin：stdin 标签
    const stdin = buildToolBodyView('shell', { action: 'write_stdin', input: 'q\n' }, '{"output":"done"}');
    expect(stdin).toMatchObject({ kind: 'shell', primary: 'q\n', primaryLabel: 'stdin' });
    // 无命令无输出（close 动作）回退 null
    expect(buildToolBodyView('shell', { action: 'close' }, '{}')).toBeNull();
  });

  it('edit_file：old/new 生成 diff，成功结果带替换摘要', () => {
    const view = buildToolBodyView(
      'edit_file',
      { old_string: 'a\nb\nc', new_string: 'a\nB\nc' },
      '{"success":true,"replacements":1,"file_change":{"lines_added":1,"lines_deleted":1}}',
    );
    expect(view?.kind).toBe('diff');
    if (view?.kind === 'diff') {
      expect(view.summary).toBe('替换 1 处 · +1 -1');
      const lines = view.blocks.flatMap((b) => (b.kind === 'hunk' ? b.lines : []));
      expect(lines.some((l) => l.type === 'add' && l.text === 'B')).toBe(true);
      expect(lines.some((l) => l.type === 'del' && l.text === 'b')).toBe(true);
    }
    // 失败结果：摘要为 error 文案
    const failed = buildToolBodyView('edit_file', { old_string: 'a', new_string: 'b' }, '{"success":false,"error":"未找到"}');
    expect(failed?.kind === 'diff' && failed.summary).toBe('未找到');
  });

  it('read_file / write_file：内容 + 行号起点 + 行数摘要；错误时不渲染内容', () => {
    const read = buildToolBodyView('read_file', { path: 'a.ts', offset: 10 }, '{"content":"l1\\nl2","total_lines":120}');
    expect(read).toMatchObject({ kind: 'file', content: 'l1\nl2', startLine: 11, summary: '共 120 行 · 第 11–12 行' });
    const write = buildToolBodyView('write_file', { path: 'b.ts', content: 'x\ny' }, '{"file_change":{"total_lines":2,"lines_added":2,"lines_deleted":0}}');
    expect(write).toMatchObject({ kind: 'write', content: 'x\ny', summary: '共 2 行 · +2 -0' });
    const readErr = buildToolBodyView('read_file', { path: 'a.ts' }, '{"error":"not found"}');
    expect(readErr?.kind === 'file' && readErr.content).toBe('');
  });

  it('web_search：结果列表与错误回显；open_web_page 带标题与正文', () => {
    const search = buildToolBodyView('web_search', { query: 'mao' }, '{"results":[{"title":"Mao","url":"https://mao.example.com","content":"简介"}]}');
    expect(search?.kind === 'web-search' && search.items).toHaveLength(1);
    const page = buildToolBodyView('open_web_page', { url: 'https://mao.example.com' }, '{"title":"Mao","content":"# 正文","content_length":4}');
    expect(page).toMatchObject({ kind: 'web-page', title: 'Mao', content: '# 正文', summary: '正文 4 字符' });
  });

  it('grep_search：按文件分组、contextual 淡显；非富视图工具返回 null', () => {
    const grep = buildToolBodyView('grep_search', { pattern: 'todo' }, '{"matches":[{"file":"a.ts","line":3,"content":"todo","contextual":false},{"file":"a.ts","line":4,"content":"x","contextual":true}],"total_matches":2}');
    expect(grep?.kind === 'grep' && grep.groups).toHaveLength(1);
    expect(grep?.kind === 'grep' && grep.summary).toBe('2 处匹配 · 1 个文件');
    expect(buildToolBodyView('page_click', { elementId: 'b' }, '{}')).toBeNull();
    // 历史结果缺失（result 空）仍渲染命令本身（执行中先见命令）
    expect(buildToolBodyView('shell', { command: 'ls' }, '')).toMatchObject({ kind: 'shell', primary: 'ls', output: '' });
  });

  it('prettyJsonOrRaw：JSON 重排缩进，非 JSON 原样', () => {
    expect(prettyJsonOrRaw('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJsonOrRaw('plain')).toBe('plain');
    expect(prettyJsonOrRaw('')).toBe('');
  });
});

describe('elapsed 耗时文案', () => {
  it('执行中走表格式与桌面端一致', () => {
    expect(formatElapsedMs(500)).toBe('0s');
    expect(formatElapsedMs(59_000)).toBe('59s');
    expect(formatElapsedMs(90_000)).toBe('1m30s');
    expect(formatElapsedMs(3_600_000)).toBe('1h');
    expect(formatElapsedMs(3_700_000)).toBe('1h1m');
  });

  it('任务耗时：起点/终点缺一或倒序返回空串', () => {
    expect(formatRoundDuration('2026-11-09T15:36:35', '2026-11-09T15:53:09')).toBe('16分34秒');
    expect(formatRoundDuration('2026-11-09T15:36:35', '2026-11-09T15:37:04')).toBe('29秒');
    expect(formatRoundDuration(undefined, '2026-11-09T15:53:09')).toBe('');
    expect(formatRoundDuration('2026-11-09T15:53:09', '2026-11-09T15:36:35')).toBe('');
  });
});

describe('toolDiff（与桌面端同实现冒烟）', () => {
  it('无变化返回空 blocks，末尾换行不产生空行', () => {
    expect(buildEditDiff('same', 'same').blocks).toEqual([]);
    const diff = buildEditDiff('a\nb\n', 'a\nB\n');
    const lines = diff.blocks.flatMap((b) => (b.kind === 'hunk' ? b.lines : []));
    expect(lines.at(-1)?.text).toBe('B');
  });
});
