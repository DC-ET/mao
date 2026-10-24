import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import { PathSandbox } from '../../safety/path-sandbox.js';
import { TaskUpdateTool } from './task-tools.js';
import { ReadFileTool } from './read-file-tool.js';

/**
 * 整数参数必须校验「原值」，不能先 Math.trunc 再 Number.isInteger。
 *
 * asInt（harness/tool/json.ts:24）内部已 Math.trunc：
 * - task_update 的 `asInt(item.id)` + `id > 0` 让 id=1.9 被当成 #1 更新（假成功）；
 * - read_file 的 parseLineIndex 里 `Number.isInteger(asInt(...))` 恒真，offset=1.5 被
 *   当成 1；offset=-0.5 得到 -0，`-0 < 0` 为 false，负小数也被接受。
 *
 * 同仓库口径（read-file-tool.ts:157-158 注释、docs/code-review BUG-D6）：负数与非整数
 * 一律抛错返回 error，不能静默截断。
 */
function fakeMapper() {
  return {
    resetInProgressIfExists: vi.fn(async () => false),
    updateFields: vi.fn(async () => undefined),
    selectBySessionId: vi.fn(async () => [] as unknown[]),
  };
}

describe('整数参数：小数必须报错而不是截断', () => {
  it('task_update id=1.9 必须报错（当前把 #1 更新并回报成功）', async () => {
    const mapper = fakeMapper();
    const tool = new TaskUpdateTool(mapper as never);
    const out = JSON.parse(await tool.execute(
      JSON.stringify({ items: [{ id: 1.9, status: 'completed' }] }), 1,
    ));

    expect(out.error).toBeDefined();
    expect(mapper.updateFields).not.toHaveBeenCalled();
  });

  it('read_file offset=1.5 必须报错（当前从第 1 行开始返回）', async () => {
    const dir = useTmpDir('mao-int-args-');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));

    const out = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', offset: 1.5 })));
    expect(out.error).toBeDefined();
  });

  it('read_file offset=-0.5 必须报错（当前落入 -0 分支被接受）', async () => {
    const dir = useTmpDir('mao-int-args-');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));

    const out = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', offset: -0.5 })));
    expect(out.error).toBeDefined();
  });

  it('对照：合法整数 offset 正常读取', async () => {
    const dir = useTmpDir('mao-int-args-');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree');
    const tool = new ReadFileTool(new PathSandbox(dir));

    const out = JSON.parse(await tool.execute(JSON.stringify({ path: 'a.txt', offset: 1 })));
    expect(out.error).toBeUndefined();
    expect(out.content).toBe('two\nthree');
  });
});
