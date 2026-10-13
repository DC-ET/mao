import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGlobSearch, handleGrepSearch, isRgAvailable } from '../src/local/tools/search';

const SESSION_ID = 909;

let workspace: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-search-')));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

/** 把 rg 探测伪装成「未安装」，用来验证纯 Node 回退分支与 rg 分支输出结构一致。 */
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

function writeFixture(): void {
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'src/a.ts'), 'one\ntwo\nNEEDLE\nfour\nfive\n');
  fs.writeFileSync(path.join(workspace, 'src/b.txt'), 'crlf\r\nNEEDLE\r\ntail\r\n');
}

describe('grep context lines', () => {
  it('emits surrounding lines as contextual without counting them as matches (rg)', async () => {
    if (!(await isRgAvailable())) return;
    writeFixture();
    const res = await handleGrepSearch(
      { pattern: 'NEEDLE', glob: '*.ts', context_lines: 1 },
      workspace,
      SESSION_ID,
    );
    expect(res.total_matches).toBe(1);
    const matches = res.matches as Array<{ line: number; content: string; contextual?: boolean }>;
    expect(matches.map((m) => m.line)).toEqual([2, 3, 4]);
    expect(matches.map((m) => m.contextual === true)).toEqual([true, false, true]);
    expect(matches.map((m) => m.content)).toEqual(['two', 'NEEDLE', 'four']);
  });

  it('emits the same shape in the node fallback', async () => {
    writeFixture();
    const search = await loadSearchWithoutRg();
    expect(await search.isRgAvailable()).toBe(false);
    const res = await search.handleGrepSearch(
      { pattern: 'NEEDLE', glob: '*.ts', context_lines: 1 },
      workspace,
      SESSION_ID,
    );
    expect(res.total_matches).toBe(1);
    const matches = res.matches as Array<{ line: number; content: string; contextual?: boolean }>;
    expect(matches.map((m) => m.line)).toEqual([2, 3, 4]);
    expect(matches.map((m) => m.contextual === true)).toEqual([true, false, true]);
    expect(matches.map((m) => m.content)).toEqual(['two', 'NEEDLE', 'four']);
  });

  it('strips CRLF from node fallback output', async () => {
    writeFixture();
    const search = await loadSearchWithoutRg();
    const res = await search.handleGrepSearch(
      { pattern: 'NEEDLE', glob: '*.txt', context_lines: 1 },
      workspace,
      SESSION_ID,
    );
    const matches = res.matches as Array<{ content: string }>;
    expect(matches.map((m) => m.content)).toEqual(['crlf', 'NEEDLE', 'tail']);
    expect(matches.every((m) => !m.content.includes('\r'))).toBe(true);
  });

  it('does not duplicate lines when matches overlap in the node fallback', async () => {
    fs.writeFileSync(path.join(workspace, 'c.ts'), 'HIT\nHIT\nHIT\n');
    const search = await loadSearchWithoutRg();
    const res = await search.handleGrepSearch({ pattern: 'HIT', context_lines: 2 }, workspace, SESSION_ID);
    const matches = res.matches as Array<{ line: number }>;
    expect(matches.map((m) => m.line)).toEqual([1, 2, 3]);
    expect(res.total_matches).toBe(3);
  });
});

describe('search failures stay visible', () => {
  it('surfaces rg failures instead of pretending there were zero matches', async () => {
    if (!(await isRgAvailable())) return;
    writeFixture();
    const res = await handleGrepSearch({ pattern: '[' }, workspace, SESSION_ID);
    expect(res.matches).toEqual([]);
    expect(String(res.error)).toMatch(/搜索失败（rg exit/);
  });

  it('reports invalid regexes in the node fallback', async () => {
    writeFixture();
    const search = await loadSearchWithoutRg();
    const res = await search.handleGrepSearch({ pattern: '(' }, workspace, SESSION_ID);
    expect(res.matches).toEqual([]);
    expect(String(res.error)).toMatch(/无效的正则表达式/);
  });

  it('returns zero matches (not an error) when nothing matches', async () => {
    writeFixture();
    const res = await handleGrepSearch({ pattern: 'NOTHING_MATCHES_HERE' }, workspace, SESSION_ID);
    expect(res.error).toBeUndefined();
    expect(res.matches).toEqual([]);
    expect(res.total_matches).toBe(0);
  });
});

describe('glob search', () => {
  it('finds files relative to the workspace with rg and with the node fallback', async () => {
    writeFixture();
    const viaRg = await handleGlobSearch({ pattern: '**/*.ts' }, workspace, SESSION_ID);
    expect(viaRg.files).toEqual([path.join('src', 'a.ts')]);
    const search = await loadSearchWithoutRg();
    const viaNode = await search.handleGlobSearch({ pattern: '**/*.ts' }, workspace, SESSION_ID);
    expect(viaNode.files).toEqual([path.join('src', 'a.ts')]);
    expect(viaNode.search_root).toBe(workspace);
  });
});

// round 1 BUG-5：数值参数的非法值处理必须与云端（backend asInt 语义 + 各 tool 校验）一致。
describe('numeric parameter semantics match the cloud tools', () => {
  // head_limit 旧实现 Number(x) || 100：0 被静默改成 100（模型要 0 条却拿到全部）、
  // 负数原样传入 slice(0, -N)（变成「全部结果砍掉末尾 N 条」的错乱子集）。
  // 云端 glob_search 对非正整数显式报错，LOCAL 必须同口径。
  it('rejects a non-positive glob head_limit instead of silently changing it', async () => {
    fs.writeFileSync(path.join(workspace, 'x.txt'), 'x');
    expect((await handleGlobSearch({ pattern: '*.txt', head_limit: 0 }, workspace, SESSION_ID)).error).toBeTruthy();
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(workspace, `f${i}.txt`), 'x');
    expect((await handleGlobSearch({ pattern: '*.txt', head_limit: -2 }, workspace, SESSION_ID)).error).toBeTruthy();
  });

  // max_output_chars=0 是合法预算（0 条匹配），旧实现 Number(x) || 10000 静默改成
  // 10000，作废模型的输出预算约束。asInt(0, 10000) = 0：0 是有限数，原样返回。
  it('honours max_output_chars=0 as a zero budget', async () => {
    fs.writeFileSync(path.join(workspace, 'g.txt'), 'hit1\nhit2\nhit3\n');
    const res = await handleGrepSearch({ pattern: 'hit', max_output_chars: 0 }, workspace, SESSION_ID);
    expect(Array.isArray(res.matches) ? res.matches.length : 0).toBe(0);
  });
});
