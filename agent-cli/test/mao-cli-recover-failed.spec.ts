import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

/**
 * mao admin-session recover-failed：preview 列失败会话，run 按 ID 发起恢复。
 */

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'skills', 'mao-cli', 'lib', 'args.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到仓库根目录（skills/mao-cli）');
}

const req = createRequire(path.join(findRepoRoot(), 'noop.js'));
const LIB = path.join(findRepoRoot(), 'skills', 'mao-cli', 'lib');

type Call = { method: string; path: string; query?: unknown; body?: unknown };

function loadModule(calls: Call[]) {
  const httpPath = path.join(LIB, 'http.js');
  const cmdPath = path.join(LIB, 'commands', 'admin-session.js');
  delete req.cache[httpPath];
  delete req.cache[cmdPath];
  const http = req(httpPath) as {
    get: (ctx: unknown, apiPath: string, query?: unknown) => Promise<unknown>;
    post: (ctx: unknown, apiPath: string, body?: unknown) => Promise<unknown>;
  };
  http.get = async (_ctx, apiPath, query) => {
    calls.push({ method: 'GET', path: apiPath, query });
    return { code: 0, data: { windowHours: 24, total: 0, recoverableCount: 0, truncated: false, items: [] } };
  };
  http.post = async (_ctx, apiPath, body) => {
    calls.push({ method: 'POST', path: apiPath, body });
    return { code: 0, data: { accepted: (body as { sessionIds: number[] }).sessionIds, skipped: [] } };
  };
  return req(cmdPath) as {
    run: (ctx: unknown, subcommand: string, rest: string[], flags: Record<string, unknown>) => Promise<void>;
  };
}

async function run(subcommand: string, rest: string[], flags: Record<string, unknown>) {
  const calls: Call[] = [];
  const mod = loadModule(calls);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  try {
    await mod.run(
      { baseUrl: 'https://mao.example.com', token: 'tok', timeoutMs: 30000, raw: false },
      subcommand,
      rest,
      flags,
    );
  } finally {
    spy.mockRestore();
  }
  return { out: chunks.join(''), calls };
}

describe('mao admin-session recover-failed', () => {
  it('preview 默认窗口 24 小时', async () => {
    const { calls } = await run('recover-failed', ['preview'], {});
    expect(calls).toEqual([{
      method: 'GET',
      path: '/admin/sessions/recover-failed/preview',
      query: { windowHours: 24 },
    }]);
  });

  it('preview 透传 window-hours', async () => {
    const { calls } = await run('recover-failed', ['preview'], { 'window-hours': '72' });
    expect(calls[0].query).toEqual({ windowHours: 72 });
  });

  it('preview 拒绝越界窗口', async () => {
    await expect(run('recover-failed', ['preview'], { 'window-hours': '169' })).rejects.toThrow(/1–168/);
  });

  it('run 按逗号分隔的正整数发起恢复，并合并重复 ID', async () => {
    const { calls } = await run('recover-failed', ['run'], { 'session-ids': '431,431,473' });
    expect(calls).toEqual([{
      method: 'POST',
      path: '/admin/sessions/recover-failed/run',
      body: { sessionIds: [431, 473] },
    }]);
  });

  it('run 缺少 session-ids、非正整数、超过 20 个都在发请求前拒绝', async () => {
    await expect(run('recover-failed', ['run'], {})).rejects.toThrow(/--session-ids/);
    await expect(run('recover-failed', ['run'], { 'session-ids': '0,-1' })).rejects.toThrow(/正整数/);
    const ids = Array.from({ length: 21 }, (_, i) => String(i + 1)).join(',');
    await expect(run('recover-failed', ['run'], { 'session-ids': ids })).rejects.toThrow(/20/);
  });

  it('没有动作时打印用法，未知动作报错', async () => {
    const { out, calls } = await run('recover-failed', [], {});
    expect(out).toContain('recover-failed preview');
    expect(calls).toHaveLength(0);
    await expect(run('recover-failed', ['frob'], {})).rejects.toThrow(/未知 admin-session recover-failed 命令: frob/);
  });
});
