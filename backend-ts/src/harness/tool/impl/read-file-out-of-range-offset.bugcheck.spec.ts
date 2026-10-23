import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { ReadFileTool } from './read-file-tool.js';
import { normalizeToolResult } from '../../tool/tool-result.js';

function tmp(): string {
  return useTmpDir('mao-read-file-range-');
}

/**
 * 回归：offset 越界（offset > total_lines）曾被 `Math.min(offset, totalLines)` 静默钳制，
 * 返回 `{ content: '', total_lines: N }` 且**不带 error 键** → normalizeToolResult 判 success。
 *
 * 模型于是以为「文件在第 N 行之后是空的」，若它据此认定文件内容为空/需要重写，
 * 就会用 write_file 整体覆写把文件清空——这正是本文件上方注释
 * 「负数钳到 0 会让模型拿到『空 content + success』……故显式报错」要防的失败模式。
 *
 * 正确行为：offset 越界时必须显式报错（带 error 键），让模型知道入参非法并重试。
 */
describe('ReadFileTool out-of-range offset', () => {
  it('reports an error instead of silently returning an empty window as success', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'small.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));

    const raw = await tool.execute(JSON.stringify({ path: 'small.txt', offset: 99 }));
    const result = JSON.parse(raw);

    // 1) 必须带 error 键：否则下游（normalizeToolResult / 审计 / 统计）把读失败当读成功
    expect(result.error).toBeDefined();
    expect(String(result.error)).toMatch(/offset/);

    // 2) 下游必须判定为失败态
    const normalized = normalizeToolResult('call-1', raw);
    expect(normalized.status).toBe('error');
    expect(normalized.errorMessage).toBeTruthy();

    // 3) 绝不能把「空窗口」当成有效内容返回给模型
    expect(result.content).not.toBe('');
  });

  it('keeps reading when offset is exactly the line count (empty tail is legitimate)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'small.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));

    const raw = await tool.execute(JSON.stringify({ path: 'small.txt', offset: 3 }));
    const result = JSON.parse(raw);
    // offset == total_lines 是合法的“读到文件末尾”，不应报错
    expect(result.error).toBeUndefined();
    expect(result.content).toBe('');
    expect(result.total_lines).toBe(3);
  });
});
