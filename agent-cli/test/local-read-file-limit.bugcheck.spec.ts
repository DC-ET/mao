import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleReadFile } from '../src/local/tools/files';

/**
 * BUGCHECK（审查新增，非产品代码）：LOCAL 侧 read_file 的 offset/limit 仍是「静默钳制」，
 * 与云端 0.0.307 之后的 parseLineIndex 校验口径分裂。
 *
 * 位置：agent-cli/src/local/tools/files.ts:268-271
 *   const offset = Math.max(0, asInt(args.offset, 0));
 *   const limit = args.limit != null ? Math.max(0, asInt(args.limit, Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;
 *
 * 云端同源实现（backend-ts/src/harness/tool/impl/read-file-tool.ts:67-77 + :152-158）：
 *   parseLineIndex() 只接受有限且非负的整数，非法值抛错 → readError() → 返回带 `error` 键的失败结果。
 *
 * 影响：模型偶发输出负数 limit 时，LOCAL 返回 `{content:'', total_lines:N}` —— 没有 error 键，
 * normalizeToolResult 判为 success；模型据此认定「文件是空的」，进而用 write_file 整体覆写清空它
 * （数据丢失）。同一份 LLM 参数在 CLOUD 报错、LOCAL 静默返回空窗，两端行为分裂。
 * 注：该缺陷在 2026-10-18 审查中以「云端 read_file」为题报过，但修复只落在云端
 * （read-file-tool.ts），agent-cli LOCAL 侧至今未同步。
 *
 * 断言按「正确行为」书写（= 云端口径），当前源码下失败即证明 BUG 真实存在。
 */
const SESSION_ID = 707;

let workspace: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-readfile-limit-')));
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'l1\nl2\nl3\nl4\nl5\n');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('BUGCHECK LOCAL read_file offset/limit 校验', () => {
  it('rejects a negative limit instead of returning a successful empty window', () => {
    const res = handleReadFile({ path: 'a.txt', limit: -5 }, workspace, SESSION_ID);
    expect(String(res.error ?? '')).toMatch(/limit/);
    expect(res.content).not.toBe('');
  });

  it('rejects a negative offset instead of silently clamping it to 0', () => {
    const res = handleReadFile({ path: 'a.txt', offset: -1 }, workspace, SESSION_ID);
    expect(String(res.error ?? '')).toMatch(/offset/);
  });

  it('rejects a non-numeric limit instead of silently reading the whole file', () => {
    const res = handleReadFile({ path: 'a.txt', limit: 'abc' }, workspace, SESSION_ID);
    expect(String(res.error ?? '')).toMatch(/limit/);
  });

  it('treats limit 0 as a legal empty window without erroring (control group)', () => {
    const res = handleReadFile({ path: 'a.txt', limit: 0 }, workspace, SESSION_ID);
    expect(res.error).toBeUndefined();
    expect(res.content).toBe('');
    expect(res.total_lines).toBe(5);
  });

  it('reads the requested window normally (control group)', () => {
    const res = handleReadFile({ path: 'a.txt', offset: 1, limit: 2 }, workspace, SESSION_ID);
    expect(res).toMatchObject({ content: 'l2\nl3', total_lines: 5 });
  });
});
