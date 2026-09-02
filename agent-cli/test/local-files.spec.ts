import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFileChangeDiff,
  computeLineDelta,
  handleEditFile,
  handleReadFile,
  handleWriteFile,
  splitLines,
} from '../src/local/tools/files';

const SESSION_ID = 606;
const DIFF_FIELD = 'file_change_diff';

let ws: string;

beforeEach(() => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-files-')));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('splitLines', () => {
  it('matches the backend read-file-tool semantics', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\rb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('computeLineDelta', () => {
  it('uses LCS instead of counting whole blocks', () => {
    expect(computeLineDelta('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ linesAdded: 1, linesDeleted: 1 });
    expect(computeLineDelta('a\nb\nc\n', 'a\nb\nc\nd\n')).toEqual({ linesAdded: 1, linesDeleted: 0 });
    expect(computeLineDelta('a\nb\nc\n', 'a\nc\n')).toEqual({ linesAdded: 0, linesDeleted: 1 });
    expect(computeLineDelta('', 'a\nb\n')).toEqual({ linesAdded: 2, linesDeleted: 0 });
    expect(computeLineDelta('a\nb\n', '')).toEqual({ linesAdded: 0, linesDeleted: 2 });
    // 中间插入一行不应被算成「整段重写」
    expect(computeLineDelta('a\nb\nc\nd\n', 'a\nb\nx\nc\nd\n')).toEqual({ linesAdded: 1, linesDeleted: 0 });
  });
});

describe('handleReadFile', () => {
  it('honours offset and limit against total_lines', () => {
    fs.writeFileSync(path.join(ws, 'n.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    expect(handleReadFile({ path: 'n.txt' }, ws, SESSION_ID)).toEqual({ content: 'l1\nl2\nl3\nl4\nl5', total_lines: 5 });
    expect(handleReadFile({ path: 'n.txt', offset: 1, limit: 2 }, ws, SESSION_ID))
      .toEqual({ content: 'l2\nl3', total_lines: 5 });
    expect(handleReadFile({ path: 'n.txt', offset: 99, limit: 2 }, ws, SESSION_ID))
      .toEqual({ content: '', total_lines: 5 });
    expect(handleReadFile({ path: 'n.txt', offset: 3, limit: 100 }, ws, SESSION_ID))
      .toEqual({ content: 'l4\nl5', total_lines: 5 });
  });

  it('does not produce blank lines for CRLF files', () => {
    fs.writeFileSync(path.join(ws, 'crlf.txt'), 'a\r\nb\r\n');
    expect(handleReadFile({ path: 'crlf.txt' }, ws, SESSION_ID)).toEqual({ content: 'a\nb', total_lines: 2 });
  });

  it('strips the BOM from the returned content', () => {
    fs.writeFileSync(path.join(ws, 'bom.txt'), '\uFEFFhello\n');
    expect(handleReadFile({ path: 'bom.txt' }, ws, SESSION_ID)).toEqual({ content: 'hello', total_lines: 1 });
  });

  it('refuses binary files instead of returning mojibake', () => {
    fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0x01, 0x00, 0x02, 0x03]));
    const res = handleReadFile({ path: 'bin.dat' }, ws, SESSION_ID);
    expect(String(res.content)).toMatch(/二进制文件无法按文本读取/);
    expect(res.total_lines).toBe(0);
  });

  it('reports missing path and missing file distinctly', () => {
    expect(String(handleReadFile({}, ws, SESSION_ID).content)).toMatch(/缺少必填参数 path/);
    expect(String(handleReadFile({ path: 'nope.txt' }, ws, SESSION_ID).content)).toMatch(/文件不存在/);
  });

  it('refuses directories', () => {
    fs.mkdirSync(path.join(ws, 'dir'));
    expect(String(handleReadFile({ path: 'dir' }, ws, SESSION_ID).content)).toMatch(/不是普通文件/);
  });
});

describe('handleWriteFile', () => {
  it('requires content and reports failures with success:false', () => {
    const res = handleWriteFile({ path: 'x.txt' }, ws, SESSION_ID);
    expect(res).toEqual({ success: false, error: '缺少必填参数 content' });
    expect(fs.existsSync(path.join(ws, 'x.txt'))).toBe(false);
  });

  it('preserves the original BOM and CRLF when rewriting', () => {
    const target = path.join(ws, 'legacy.txt');
    fs.writeFileSync(target, '\uFEFFold\r\nline\r\n');
    handleWriteFile({ path: 'legacy.txt', content: 'new\nline\n' }, ws, SESSION_ID);
    const raw = fs.readFileSync(target, 'utf8');
    expect(raw).toBe('\uFEFFnew\r\nline\r\n');
  });

  it('attaches a snapshot file_change_diff for the renderer', () => {
    handleWriteFile({ path: 'd.txt', content: 'a\nb\n' }, ws, SESSION_ID);
    const res = handleWriteFile({ path: 'd.txt', content: 'a\nc\n' }, ws, SESSION_ID);
    expect(res.success).toBe(true);
    expect(res.file_change).toEqual({
      path: 'd.txt', type: 'MODIFIED', total_lines: 2, lines_added: 1, lines_deleted: 1,
    });
    expect(res[DIFF_FIELD]).toEqual({
      diff_mode: 'SNAPSHOT', before_content: 'a\nb\n', after_content: 'a\nc\n', patch_truncated: false,
    });
  });

  it('marks new files as CREATED', () => {
    const res = handleWriteFile({ path: 'sub/fresh.txt', content: 'x\n' }, ws, SESSION_ID);
    expect((res.file_change as { type: string }).type).toBe('CREATED');
    expect(fs.readFileSync(path.join(ws, 'sub/fresh.txt'), 'utf8')).toBe('x\n');
  });
});

describe('handleEditFile', () => {
  it('requires both old_string and new_string as strings', () => {
    fs.writeFileSync(path.join(ws, 'e.txt'), 'hello\n');
    expect(handleEditFile({ path: 'e.txt', old_string: 'hello' }, ws, SESSION_ID))
      .toEqual({ success: false, replacements: 0, error: '缺少必填参数: old_string, new_string' });
    expect(handleEditFile({ path: 'e.txt', old_string: 'hello', new_string: null }, ws, SESSION_ID).success).toBe(false);
    expect(fs.readFileSync(path.join(ws, 'e.txt'), 'utf8')).toBe('hello\n');
  });

  it('refuses a no-op edit where old_string === new_string', () => {
    fs.writeFileSync(path.join(ws, 'e.txt'), 'hello\n');
    const res = handleEditFile({ path: 'e.txt', old_string: 'hello', new_string: 'hello' }, ws, SESSION_ID);
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/完全相同/);
  });

  it('reports a missing file rather than creating one', () => {
    const res = handleEditFile({ path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ws, SESSION_ID);
    expect(String(res.error)).toMatch(/文件不存在/);
    expect(fs.existsSync(path.join(ws, 'ghost.txt'))).toBe(false);
  });

  it('counts line delta with LCS and keeps CRLF', () => {
    fs.writeFileSync(path.join(ws, 'e.txt'), 'a\r\nb\r\nc\r\n');
    const res = handleEditFile({ path: 'e.txt', old_string: 'b', new_string: 'B' }, ws, SESSION_ID);
    expect(res.success).toBe(true);
    expect(res.file_change).toEqual({ path: 'e.txt', type: 'MODIFIED', lines_added: 1, lines_deleted: 1 });
    expect(fs.readFileSync(path.join(ws, 'e.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n');
  });
});

describe('buildFileChangeDiff', () => {
  it('falls back to a unified patch beyond the snapshot limit', () => {
    // 6 万行 × ~10B ≈ 600KB，超过 SNAPSHOT_LIMIT_BYTES 后走 PATCH 模式。
    const head = Array.from({ length: 60_000 }, (_, i) => `line${i}`).join('\n');
    const diff = buildFileChangeDiff('big.txt', `${head}\ntail\n`, `${head}\nTAIL\n`);
    expect(diff.diff_mode).toBe('PATCH');
    expect(diff.patch_truncated).toBe(false);
    const patch = String(diff.patch_content);
    expect(patch).toContain('--- a/big.txt');
    expect(patch).toContain('+++ b/big.txt');
    expect(patch).toContain('-tail');
    expect(patch).toContain('+TAIL');
    expect(patch).toContain(' line59999');
  });

  it('truncates a patch that itself exceeds the char limit', () => {
    const before = `${'x'.repeat(600 * 1024)}\ntail\n`;
    const diff = buildFileChangeDiff('huge-line.txt', before, `${'x'.repeat(600 * 1024)}\nTAIL\n`);
    expect(diff.diff_mode).toBe('PATCH');
    expect(diff.patch_truncated).toBe(true);
    expect(String(diff.patch_content)).toContain('...[diff truncated]');
  });

  it('reports UNSUPPORTED for binary content', () => {
    const diff = buildFileChangeDiff('b.bin', 'a\u0000b', 'c');
    expect(diff.diff_mode).toBe('UNSUPPORTED');
    expect(diff.patch_truncated).toBe(false);
  });
});
