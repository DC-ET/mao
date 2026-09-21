import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { ReadFileTool } from './read-file-tool.js';
import { WriteFileTool } from './write-file-tool.js';
import { EditFileTool } from './edit-file-tool.js';
import { GlobSearchTool } from './glob-search-tool.js';
import { GrepSearchTool } from './grep-search-tool.js';
import { PRIVATE_DIFF_FIELD } from '../file-change-diff-util.js';

function tmp(): string {
  return useTmpDir('mao-file-tools-');
}

describe('ReadFileTool', () => {
  it('readsWholeFileAndSupportsAliasPathFields', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ file_path: 'a.txt' })));
    expect(result.content).toBe('one\ntwo\nthree');
    expect(result.total_lines).toBe(3);
  });

  it('readsOffsetAndLimitWindow', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', offset: 1, limit: 2 })));
    expect(result.content).toBe('two\nthree');
    expect(result.total_lines).toBe(4);
  });

  it('does not count a trailing newline as an extra line', async () => {
    const dir = tmp();
    const tool = new ReadFileTool(new PathSandbox(dir));
    writeFileSync(join(dir, 'trailing.txt'), 'one\ntwo\n');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'trailing.txt' }))).total_lines).toBe(2);
    writeFileSync(join(dir, 'blank-tail.txt'), 'one\n\n');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'blank-tail.txt' }))).total_lines).toBe(2);
    writeFileSync(join(dir, 'empty.txt'), '');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'empty.txt' }))).total_lines).toBe(0);
  });

  it('normalizes CRLF line endings', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'crlf.txt'), 'one\r\ntwo\r\n');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'crlf.txt' })));
    expect(result.total_lines).toBe(2);
    expect(result.content).toBe('one\ntwo');
  });

  it('returnsFriendlyErrorsForMissingPathMissingFileAndDirectories', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'dir'));
    const tool = new ReadFileTool(new PathSandbox(dir));
    expect(JSON.parse(await tool.execute('{}')).content).toContain('缺少必填参数');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'missing.txt' }))).content).toContain('文件不存在');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'dir' }))).content).toContain('不是普通文件');
  });

  it('truncatesVeryLargeOutput', async () => {
    const dir = tmp();
    const content = Array.from({ length: 6000 }, (_, i) => `line-${i}-abcdefghijklmnopqrstuvwxyz`).join('\n');
    writeFileSync(join(dir, 'large.txt'), content);
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'large.txt' })));
    expect(result.content).toContain('[output truncated]');
  });

  it('readsPngImageWithDataUri', async () => {
    const dir = tmp();
    await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 0, g: 0, b: 255 } } })
      .png().toFile(join(dir, 'shot.png'));
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'shot.png' })));
    expect(result.media_type).toBe('image');
    expect(result.mime).toBe('image/png');
    expect(result.data_uri).toMatch(/^data:image\/png;base64,/);
    expect(result.width).toBe(32);
    expect(result.height).toBe(24);
    expect(result.content).toContain('图片读取成功');
  });

  it('resizesLargePngForPromptBudget', async () => {
    const dir = tmp();
    await sharp({ create: { width: 2048, height: 2048, channels: 3, background: { r: 10, g: 20, b: 30 } } })
      .png().toFile(join(dir, 'huge.png'));
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'huge.png' })));
    expect(result.media_type).toBe('image');
    expect(result.width).toBe(1600);
    expect(result.height).toBe(1600);
    expect(result.content).toContain('2048×2048→1600×1600');
    expect(result.data_uri).toMatch(/^data:image\/png;base64,/);
  });

  it('rejectsFakePngExtensionWithInvalidContent', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'fake.png'), 'not an image');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'fake.png' })));
    expect(result.content).toContain('不支持的图片格式');
  });

  it('readsAbsolutePathOutsideWorkspace', async () => {
    const dir = tmp();
    const outside = await tmp();
    writeFileSync(join(outside, 'pic.txt'), 'outside content');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: join(outside, 'pic.txt') })));
    expect(result.content).toBe('outside content');
  });
});

describe('WriteFileTool', () => {
  it('reportsLineDeltasWhenOverwritingExistingFile', async () => {
    const dir = tmp();
    const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n');
    writeFileSync(join(dir, 'sample.txt'), lines(1, 100));
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'sample.txt', content: lines(1, 150) })));
    expect(result.file_change.lines_added).toBe(50);
    expect(result.file_change.lines_deleted).toBe(0);
  });

  it('reportsTotalLinesWhenCreatingFile', async () => {
    const dir = tmp();
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'created.txt',
      content: 'line 1\nline 2\nline 3',
    })));
    expect(result.file_change.lines_added).toBe(3);
    expect(result.file_change.lines_deleted).toBe(0);
    expect(existsSync(join(dir, 'created.txt'))).toBe(true);
  });

  it('does not count a trailing newline as an extra line', async () => {
    const dir = tmp();
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 't.txt', content: 'one\ntwo\n' })));
    expect(result.file_change.total_lines).toBe(2);
  });

  it('preserves original BOM and CRLF when overwriting an existing file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'legacy.txt'), '\uFEFFold\r\nline\r\n');
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'legacy.txt', content: 'new\nline\n' })));
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, 'legacy.txt'), 'utf8')).toBe('\uFEFFnew\r\nline\r\n');
  });
});

describe('EditFileTool', () => {
  it('replacesAUniqueMatchAndReportsDiffPayload', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha\nold\nbeta\n');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new',
    })));
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);
    expect(result.file_change.lines_added).toBe(1);
    expect(result[PRIVATE_DIFF_FIELD]).toBeTruthy();
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nnew\nbeta\n');
  });

  it('preserves original BOM and CRLF on a unique replacement', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), '\uFEFFalpha\r\nold\r\nbeta\r\n');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new',
    })));
    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('\uFEFFalpha\r\nnew\r\nbeta\r\n');
  });

  it('rejectsAmbiguousMatchWithoutReplaceAllAndLeavesFileUnchanged', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha\nold\nbeta\nold\n');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new',
    })));
    expect(result.success).toBe(false);
    expect(result.replacements).toBe(0);
    expect(result.occurrences).toBe(2);
    expect(result.occurrence_lines).toEqual([2, 4]);
    expect(result.error).toContain('出现 2 次');
    expect(result.error).toContain('replace_all=true');
    expect(result.error).toContain('第 2 行');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nold\nbeta\nold\n');
  });

  it('replacesAllOccurrencesWhenReplaceAllIsTrue', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha\nold\nbeta\nold\n');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new', replace_all: true,
    })));
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(2);
    expect(result.file_change.lines_added).toBe(2);
    expect(result[PRIVATE_DIFF_FIELD]).toBeTruthy();
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nnew\nbeta\nnew\n');
  });

  it('acceptsReplaceAllAsStringTrue', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'old old');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new', replace_all: 'true',
    })));
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(2);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new new');
  });

  it('truncatesLongOccurrencePreviewInAmbiguousError', async () => {
    const dir = tmp();
    const long = `prefix-${'x'.repeat(200)}`;
    writeFileSync(join(dir, 'a.txt'), `${long}\n${long}`);
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'prefix-', new_string: 'p-',
    })));
    expect(result.success).toBe(false);
    expect(result.occurrences).toBe(2);
    expect(result.error).toContain('…');
  });

  it('rejectsIdenticalOldAndNewStringsWithoutEditingFile', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'alpha', new_string: 'alpha',
    })));
    expect(result.success).toBe(false);
    expect(result.replacements).toBe(0);
    expect(result.error).toContain('完全相同');
    expect(result.error).toContain('未执行编辑');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha');
  });

  it('returnsErrorsWhenFileMissingOrNeedleMissing', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha');
    const tool = new EditFileTool(new PathSandbox(dir));
    const missingFile = JSON.parse(await tool.execute(JSON.stringify({
      path: 'missing.txt', old_string: 'x', new_string: 'y',
    })));
    const missingNeedle = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'x', new_string: 'y',
    })));
    const emptyNeedle = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: '', new_string: 'y',
    })));
    expect(missingFile.success).toBe(false);
    expect(missingFile.error).toContain('文件不存在');
    expect(missingNeedle.success).toBe(false);
    expect(missingNeedle.error).toContain('未找到');
    expect(emptyNeedle.success).toBe(false);
    expect(emptyNeedle.error).toContain('不能为空');
  });
});

describe('SearchTools', () => {
  it('globSearchFindsNestedPathPatternRegardlessOfProcessCwd', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'desktop'));
    writeFileSync(join(dir, 'desktop/package.json'), '{}');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'desktop/package.json' })));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toBe('desktop/package.json');
    expect(result.search_root).toBe(dir);
  });

  it('globSearchDoesNotMarkExactLimitAsTruncated', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src/main'), { recursive: true });
    writeFileSync(join(dir, 'src/main/App.java'), 'class App {}');
    writeFileSync(join(dir, 'README.md'), 'docs');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '**/*.java', head_limit: 1 })));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toContain('App.java');
    expect(result.truncated).toBe(false);
    expect(result.total_matched).toBe(1);
  });

  it('globSearchSupportsBracesClassesAndLiteralDots', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src/nested'), { recursive: true });
    for (const file of ['src/a.ts', 'src/nested/b.js', 'src/nested/c.ts', 'src/catalog', 'src/a.log']) {
      writeFileSync(join(dir, file), '');
    }
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'src/**/[ab].{ts,js}' })));
    expect(result.files.sort()).toEqual(['src/a.ts', 'src/nested/b.js']);
    const logs = JSON.parse(await tool.execute(JSON.stringify({ pattern: '*.log' })));
    expect(logs.files).toEqual(['src/a.log']);
  });

  it('globSearchMarksOnlyAdditionalMatchesAsTruncated', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), '');
    writeFileSync(join(dir, 'b.txt'), '');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '*.txt', head_limit: 1 })));
    expect(result.files).toHaveLength(1);
    expect(result.total_matched).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('globSearchUsesExplicitIgnoreRulesAndSkipsSymlinkLoops', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules/a.txt'), '');
    writeFileSync(join(dir, '.hidden.txt'), '');
    writeFileSync(join(dir, 'ignored.txt'), '');
    writeFileSync(join(dir, '.gitignore'), '*.txt\n');
    symlinkSync(dir, join(dir, 'loop'));
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '*.txt' })));
    expect(result.files.sort()).toEqual(['.hidden.txt', 'ignored.txt']);
  });

  it('globSearchRestrictsSingleFileScope', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), '');
    writeFileSync(join(dir, 'b.txt'), '');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', pattern: '*.txt' })));
    expect(result.files).toEqual(['a.txt']);
  });

  it('globSearchReportsMissingPathsAndInvalidLimits', async () => {
    const dir = tmp();
    const tool = new GlobSearchTool(new PathSandbox(dir));
    const missing = JSON.parse(await tool.execute(JSON.stringify({ path: 'missing', pattern: '*' })));
    expect(missing.error).toBeTruthy();
    for (const head_limit of [0, -1, 1.5, '2']) {
      const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '*', head_limit })));
      expect(result.error).toContain('head_limit');
    }
  });

  it('grepSearchFindsMatchesInSingleFilePath', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'desktop/src'), { recursive: true });
    writeFileSync(join(dir, 'desktop/src/useChat.ts'), 'export function useChat() {}\nneedle line\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ pattern: 'needle', path: 'desktop/src/useChat.ts' }),
      dir,
    ));
    expect(result.total_matches).toBe(1);
    expect(result.matches[0].file).toBe('desktop/src/useChat.ts');
  });

  it('grepSearchFindsMatchesWithContextAndIgnoreCase', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.txt'), 'before\nNeedle here\nafter\n');
    writeFileSync(join(dir, 'src/b.md'), 'needle ignored by glob\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      pattern: 'needle', glob: '*.txt', ignore_case: true, context_lines: 1,
    })));
    expect(result.total_matches).toBe(1);
    expect(result.matches.length).toBe(3);
    expect(result.matches[0].file).toContain('a.txt');
    expect(result.matches[0].line).toBe(1);
    expect(result.matches[0].contextual).toBe(true);
    expect(result.matches[1].line).toBe(2);
    expect(result.matches[1].contextual).toBeUndefined();
    expect(result.matches[2].line).toBe(3);
    expect(result.matches[2].contextual).toBe(true);
  });

  it('grepSearchRecursiveGlobMatchesRootFilesWithoutRg', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'README.md'), 'needle root\n');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), 'needle nested\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      pattern: 'needle', glob: '**/*.md',
    })));
    expect(result.total_matches).toBe(2);
  });

  it('grepSearchStreamsLargeLogsWithoutRg', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'fin.log'), `${'ordinary log line\n'.repeat(700000)}before\nNeedle 中文\nafter`);
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: dir, glob: 'fin.log', pattern: '^needle 中文$', ignore_case: true, context_lines: 1,
    })));
    expect(result.error).toBeUndefined();
    expect(result.total_matches).toBe(1);
    expect(result.matches.map((entry: { line: number }) => entry.line)).toEqual([700001, 700002, 700003]);
    expect(result.matches.map((entry: { content: string }) => entry.content)).toEqual(['before', 'Needle 中文', 'after']);
  });

  it('grepSearchDeduplicatesOverlappingContextWithoutRg', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'before\r\nneedle\r\nneedle\r\nbetween\r\nneedle\r\nafter\r\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '^needle$', context_lines: 2 })));
    expect(result.total_matches).toBe(3);
    expect(result.matches.map((entry: { line: number }) => entry.line)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.matches.map((entry: { contextual?: boolean }) => !!entry.contextual)).toEqual([true, false, false, true, false, true]);
  });

  it('grepSearchDoesNotInventAnEmptyLineAtEofWithoutRg', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'text\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '^$' })));
    expect(result.total_matches).toBe(0);
  });

  it('grepSearchReportsMissingPathsWithoutRg', async () => {
    const dir = tmp();
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'needle', path: join(dir, 'missing') })));
    expect(result.error).toBeTruthy();
    expect(result.total_matches).toBeUndefined();
  });

  it('grepSearchReportsTraversalErrorsWithoutRg', async () => {
    const dir = tmp();
    symlinkSync(join(dir, 'missing'), join(dir, 'broken.txt'));
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'needle' })));
    expect(result.error).toContain('ENOENT');
  });

  it('grepSearchStopsBeforeTraversingMoreFilesOnceTruncated', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'needle\n');
    symlinkSync(join(dir, 'missing'), join(dir, 'z.txt'));
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'needle', max_output_chars: 1 })));
    expect(result.error).toBeUndefined();
    expect(result.truncated).toBe(true);
  });

  it('grepSearchMarksTruncatedWhenOutputLimitIsExceeded', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.txt'), 'needle one\nneedle two\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      pattern: 'needle', max_output_chars: 1,
    })));
    expect(result.truncated).toBe(true);
  });
});
