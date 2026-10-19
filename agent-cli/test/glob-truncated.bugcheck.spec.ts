import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGlobSearch, isRgAvailable } from '../src/local/tools/search';

/**
 * 回归用例：glob_search 把「命中数恰好等于 head_limit」误报为 truncated=true。
 *
 * 位置：agent-cli/src/local/tools/search.ts:122 —— `truncated: files.length >= headLimit`。
 * rg 分支在 :91 用 slice(0, headLimit) 截断、Node 分支在 :56/:64 一到上限就停，
 * 两者都无法区分「恰好命中 N 条」与「还有更多」；`>=` 把「配额刚好用满」当成「结果被截断」。
 *
 * 权威口径（云端同源实现）：backend-ts/src/harness/tool/impl/glob-search-tool.ts:70-77
 * 只有真的遇到第 head_limit+1 个匹配文件时才置 truncated=true；恰好命中 N 个时是 false。
 * 期望：workspace 内只有 1 个 *.ts、head_limit=1 时 truncated=false；
 * 有 2 个匹配、head_limit=1 时 truncated=true（对照组）。
 */
const SESSION_ID = 909;

let workspace: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-glob-trunc-')));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

/** 把 rg 探测伪装成「未安装」，走纯 Node 回退分支。 */
async function loadSearchWithoutRg(): Promise<typeof import('../src/local/tools/search')> {
  vi.resetModules();
  vi.doMock('node:child_process', () => ({
    execFile: (...params: unknown[]) => {
      const cb = params[params.length - 1] as (e: Error, stdout: string, stderr: string) => void;
      cb(Object.assign(new Error('spawn rg ENOENT'), { code: 'ENOENT' }), '', '');
    },
  }));
  return import('../src/local/tools/search');
}

describe('glob_search truncated flag (node fallback)', () => {
  it('reports truncated=false when matches exactly equal head_limit', async () => {
    const search = await loadSearchWithoutRg();
    fs.writeFileSync(path.join(workspace, 'only.ts'), 'x');

    const res = await search.handleGlobSearch({ pattern: '*.ts', head_limit: 1 }, workspace, SESSION_ID);

    expect(res.files).toEqual(['only.ts']);
    expect(res.total_matched).toBe(1);
    // 恰好 1 个匹配、上限 1：没有任何结果被丢弃，不应报告截断
    expect(res.truncated).toBe(false);
  });

  it('reports truncated=true when more matches exist than head_limit (control group)', async () => {
    const search = await loadSearchWithoutRg();
    fs.writeFileSync(path.join(workspace, 'a.ts'), 'x');
    fs.writeFileSync(path.join(workspace, 'b.ts'), 'y');

    const res = await search.handleGlobSearch({ pattern: '*.ts', head_limit: 1 }, workspace, SESSION_ID);

    expect((res.files as string[]).length).toBe(1);
    expect(res.truncated).toBe(true);
  });
});

describe('glob_search truncated flag (rg path)', () => {
  it('reports truncated=false when matches exactly equal head_limit', async () => {
    if (!(await isRgAvailable())) return;
    fs.writeFileSync(path.join(workspace, 'only.ts'), 'x');

    const res = await handleGlobSearch({ pattern: '*.ts', head_limit: 1 }, workspace, SESSION_ID);

    expect(res.files).toEqual(['only.ts']);
    expect(res.truncated).toBe(false);
  });
});
