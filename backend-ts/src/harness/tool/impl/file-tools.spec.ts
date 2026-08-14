import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { ReadFileTool } from './read-file-tool.js';
import { WriteFileTool } from './write-file-tool.js';
import { EditFileTool } from './edit-file-tool.js';
import { GlobSearchTool } from './glob-search-tool.js';
import { GrepSearchTool } from './grep-search-tool.js';
import { PRIVATE_DIFF_FIELD } from '../file-change-diff-util.js';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'mao-file-tools-'));
}

describe('ReadFileTool', () => {
  it('readsWholeFileAndSupportsAliasPathFields', async () => {
    const dir = await tmp();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ file_path: 'a.txt' })));
    expect(result.content).toBe('one\ntwo\nthree');
    expect(result.total_lines).toBe(3);
  });

  it('readsOffsetAndLimitWindow', async () => {
    const dir = await tmp();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', offset: 1, limit: 2 })));
    expect(result.content).toBe('two\nthree');
    expect(result.total_lines).toBe(4);
  });

  it('returnsFriendlyErrorsForMissingPathMissingFileAndDirectories', async () => {
    const dir = await tmp();
    mkdirSync(join(dir, 'dir'));
    const tool = new ReadFileTool(new PathSandbox(dir));
    expect(JSON.parse(await tool.execute('{}')).content).toContain('缺少必填参数');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'missing.txt' }))).content).toContain('文件不存在');
    expect(JSON.parse(await tool.execute(JSON.stringify({ path: 'dir' }))).content).toContain('不是普通文件');
  });

  it('truncatesVeryLargeOutput', async () => {
    const dir = await tmp();
    const content = Array.from({ length: 6000 }, (_, i) => `line-${i}-abcdefghijklmnopqrstuvwxyz`).join('\n');
    writeFileSync(join(dir, 'large.txt'), content);
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'large.txt' })));
    expect(result.content).toContain('[output truncated]');
  });

  it('readsPngImageWithDataUri', async () => {
    const dir = await tmp();
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
    const dir = await tmp();
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
    const dir = await tmp();
    writeFileSync(join(dir, 'fake.png'), 'not an image');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'fake.png' })));
    expect(result.content).toContain('不支持的图片格式');
  });

  it('readsAbsolutePathOutsideWorkspace', async () => {
    const dir = await tmp();
    const outside = await tmp();
    writeFileSync(join(outside, 'pic.txt'), 'outside content');
    const tool = new ReadFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: join(outside, 'pic.txt') })));
    expect(result.content).toBe('outside content');
  });
});

describe('WriteFileTool', () => {
  it('reportsLineDeltasWhenOverwritingExistingFile', async () => {
    const dir = await tmp();
    const lines = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n');
    writeFileSync(join(dir, 'sample.txt'), lines(1, 100));
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({ path: 'sample.txt', content: lines(1, 150) })));
    expect(result.file_change.lines_added).toBe(50);
    expect(result.file_change.lines_deleted).toBe(0);
  });

  it('reportsTotalLinesWhenCreatingFile', async () => {
    const dir = await tmp();
    const tool = new WriteFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'created.txt',
      content: 'line 1\nline 2\nline 3',
    })));
    expect(result.file_change.lines_added).toBe(3);
    expect(result.file_change.lines_deleted).toBe(0);
    expect(existsSync(join(dir, 'created.txt'))).toBe(true);
  });
});

describe('EditFileTool', () => {
  it('replacesAllOccurrencesAndReportsDiffPayload', async () => {
    const dir = await tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha\nold\nbeta\nold\n');
    const tool = new EditFileTool(new PathSandbox(dir));
    const result = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'old', new_string: 'new',
    })));
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(2);
    expect(result.file_change.lines_added).toBe(2);
    expect(result[PRIVATE_DIFF_FIELD]).toBeTruthy();
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('alpha\nnew\nbeta\nnew\n');
  });

  it('rejectsIdenticalOldAndNewStringsWithoutEditingFile', async () => {
    const dir = await tmp();
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
    const dir = await tmp();
    writeFileSync(join(dir, 'a.txt'), 'alpha');
    const tool = new EditFileTool(new PathSandbox(dir));
    const missingFile = JSON.parse(await tool.execute(JSON.stringify({
      path: 'missing.txt', old_string: 'x', new_string: 'y',
    })));
    const missingNeedle = JSON.parse(await tool.execute(JSON.stringify({
      path: 'a.txt', old_string: 'x', new_string: 'y',
    })));
    expect(missingFile.success).toBe(false);
    expect(missingFile.error).toContain('文件不存在');
    expect(missingNeedle.success).toBe(false);
    expect(missingNeedle.error).toContain('未找到');
  });
});

describe('SearchTools', () => {
  it('globSearchFindsNestedPathPatternRegardlessOfProcessCwd', async () => {
    const dir = await tmp();
    mkdirSync(join(dir, 'desktop'));
    writeFileSync(join(dir, 'desktop/package.json'), '{}');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: 'desktop/package.json' })));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toBe('desktop/package.json');
    expect(result.search_root).toBe(dir);
  });

  it('globSearchFindsFilesWithJavaFallbackAndMarksTruncation', async () => {
    const dir = await tmp();
    mkdirSync(join(dir, 'src/main'), { recursive: true });
    writeFileSync(join(dir, 'src/main/App.java'), 'class App {}');
    writeFileSync(join(dir, 'README.md'), 'docs');
    const tool = new GlobSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({ pattern: '**/*.java', head_limit: 1 })));
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toContain('App.java');
    expect(result.truncated).toBe(true);
    expect(result.total_matched).toBe(1);
  });

  it('grepSearchFindsMatchesInSingleFilePath', async () => {
    const dir = await tmp();
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
    const dir = await tmp();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.txt'), 'before\nNeedle here\nafter\n');
    writeFileSync(join(dir, 'src/b.md'), 'needle ignored by glob\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      pattern: 'needle', glob: '*.txt', ignore_case: true, context_lines: 1,
    })));
    expect(result.total_matches).toBe(1);
    expect(result.matches[0].file).toContain('a.txt');
    expect(result.matches[0].line).toBe(2);
    expect(result.matches[0].context_before[0]).toBe('before');
    expect(result.matches[0].context_after[0]).toBe('after');
  });

  it('grepSearchMarksTruncatedWhenOutputLimitIsExceeded', async () => {
    const dir = await tmp();
    writeFileSync(join(dir, 'a.txt'), 'needle one\nneedle two\n');
    const tool = new GrepSearchTool(new PathSandbox(dir));
    (tool as unknown as { rgAvailable: boolean }).rgAvailable = false;
    const result = JSON.parse(await tool.execute(JSON.stringify({
      pattern: 'needle', max_output_chars: 1,
    })));
    expect(result.truncated).toBe(true);
  });
});
