import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * mao-cli env 模块：用户 / 工作区 / 系统三层，以及会话生效视图和管理员只读视图。
 * 断言 method + path + query + body 与 backend-ts env-variable.routes.ts 对齐。
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

const root = findRepoRoot();
const req = createRequire(path.join(root, 'noop.js'));
const LIB = path.join(root, 'skills', 'mao-cli', 'lib');

type RequestCall = {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  token?: string;
  baseUrl?: string;
};
type EnvModule = { handle: (ctx: unknown) => Promise<void>; HELP: string };

function loadModule(calls: RequestCall[]): EnvModule {
  const httpPath = path.join(LIB, 'http.js');
  const cmdPath = path.join(LIB, 'commands', 'env.js');
  delete req.cache[httpPath];
  delete req.cache[cmdPath];
  const http = req(httpPath) as { request: (o: RequestCall) => Promise<unknown> };
  http.request = async (opts: RequestCall) => {
    calls.push(opts);
    return { code: 0, message: 'ok', data: { id: 1 } };
  };
  return req(cmdPath) as EnvModule;
}

async function run(
  subcommand: string | undefined,
  flags: Record<string, unknown>,
  rest: string[] = [],
): Promise<{ out: string; calls: RequestCall[] }> {
  const calls: RequestCall[] = [];
  const mod = loadModule(calls);
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  try {
    await mod.handle({
      subcommand,
      flags,
      rest,
      globals: { baseUrl: 'https://mao.example.com', token: 'test-token', timeoutMs: 30000, json: true, raw: false },
    });
  } finally {
    spy.mockRestore();
  }
  return { out: chunks.join(''), calls };
}

function expectCall(calls: RequestCall[], expected: Partial<RequestCall>): RequestCall {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject(expected);
  expect(calls[0].baseUrl).toBe('https://mao.example.com');
  expect(calls[0].token).toBe('test-token');
  return calls[0];
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mao env 成功路径', () => {
  it('user list', async () => {
    const { calls } = await run('user', {}, ['list']);
    expectCall(calls, { method: 'GET', path: '/user/env-variables' });
  });

  it('user create 只提交显式字段', async () => {
    const { calls } = await run('user', { key: 'OPENAI_API_KEY', value: 'sk-test' }, ['create']);
    const call = expectCall(calls, { method: 'POST', path: '/user/env-variables' });
    expect(call.body).toEqual({ envKey: 'OPENAI_API_KEY', envValue: 'sk-test' });
  });

  it('user create --value-file 读入文件原文（保留末尾换行）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-env-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'key.txt');
    fs.writeFileSync(file, 'secret\n', 'utf8');
    const { calls } = await run('user', { key: 'TOKEN', 'value-file': file, note: '文件' }, ['create']);
    expect(calls[0].body).toEqual({ envKey: 'TOKEN', envValue: 'secret\n', note: '文件' });
  });

  it('user update 只改备注时不带 envValue', async () => {
    const { calls } = await run('user', { id: '4', note: '只改备注' }, ['update']);
    const call = expectCall(calls, { method: 'PUT', path: '/user/env-variables/4' });
    expect(call.body).toEqual({ note: '只改备注' });
  });

  it('user update 显式空值仍下发空串（服务端保留原密文）', async () => {
    const { calls } = await run('user', { id: '4', value: '' }, ['update']);
    expect(calls[0].body).toEqual({ envValue: '' });
  });

  it('user update 空备注下发空串（服务端清空备注）', async () => {
    const { calls } = await run('user', { id: '4', note: '' }, ['update']);
    expect(calls[0].body).toEqual({ note: '' });
  });

  it('user delete', async () => {
    const { calls } = await run('user', { id: '4' }, ['delete']);
    expectCall(calls, { method: 'DELETE', path: '/user/env-variables/4' });
  });

  it('workspace list / create 带工作区路径', async () => {
    const ws = '/opt/mao-data/workspace/demo';
    const listed = await run('workspace', { workspace: ws }, ['list']);
    expectCall(listed.calls, { method: 'GET', path: '/user/workspace-env-variables', query: { workspace: ws } });

    const created = await run('workspace', { workspace: ws, key: 'API_BASE', value: 'https://api.example.com' }, ['create']);
    const call = expectCall(created.calls, { method: 'POST', path: '/user/workspace-env-variables' });
    expect(call.body).toEqual({
      envKey: 'API_BASE',
      envValue: 'https://api.example.com',
      workspacePath: ws,
    });
  });

  it('workspace update 不要求重传路径', async () => {
    const { calls } = await run('workspace', { id: '8', key: 'API_BASE' }, ['update']);
    const call = expectCall(calls, { method: 'PUT', path: '/user/workspace-env-variables/8' });
    expect(call.body).toEqual({ envKey: 'API_BASE' });
  });

  it('system CRUD 走管理端路径', async () => {
    const listed = await run('system', {}, ['list']);
    expectCall(listed.calls, { method: 'GET', path: '/admin/system-env-variables' });

    const created = await run('system', { key: 'CORP_API', value: 'https://corp.example.com', note: '全站' }, ['create']);
    expect(created.calls[0].body).toEqual({
      envKey: 'CORP_API',
      envValue: 'https://corp.example.com',
      note: '全站',
    });
    expect(created.calls[0].path).toBe('/admin/system-env-variables');

    const deleted = await run('system', { id: '2' }, ['delete']);
    expectCall(deleted.calls, { method: 'DELETE', path: '/admin/system-env-variables/2' });
  });

  it('effective 按会话查询', async () => {
    const { calls } = await run('effective', { 'session-id': '42' });
    expectCall(calls, { method: 'GET', path: '/sessions/42/effective-env' });
  });

  it('user-of 与 workspace-of', async () => {
    const user = await run('user-of', { 'user-id': '7' });
    expectCall(user.calls, { method: 'GET', path: '/admin/users/7/env-variables' });

    const all = await run('workspace-of', { 'user-id': '7' });
    expectCall(all.calls, { method: 'GET', path: '/admin/users/7/workspace-env-variables' });
    expect(all.calls[0].query == null || Object.keys(all.calls[0].query ?? {}).length === 0).toBe(true);

    const one = await run('workspace-of', { 'user-id': '7', workspace: '/opt/mao-data/workspace/demo' });
    expectCall(one.calls, {
      method: 'GET',
      path: '/admin/users/7/workspace-env-variables',
      query: { workspace: '/opt/mao-data/workspace/demo' },
    });
  });

  it('无子命令或 --help 只打印帮助', async () => {
    const mod = loadModule([]);
    const bare = await run(undefined, {});
    expect(bare.calls).toHaveLength(0);
    expect(bare.out).toContain('mao env user list');
    expect(bare.out).toBe(mod.HELP);

    const helped = await run('user', { help: true }, ['list']);
    expect(helped.calls).toHaveLength(0);
    expect(helped.out).toContain('shell.envVars.enabled');
  });
});

describe('mao env 缺参与非法输入', () => {
  it('create 缺值、值文件与 --value 冲突、空值', async () => {
    await expect(run('user', { key: 'A' }, ['create'])).rejects.toThrow(/缺少必填参数 --value/);
    await expect(run('user', { key: 'A', value: 'x', 'value-file': '/tmp/a' }, ['create'])).rejects.toThrow(/只能二选一/);
    await expect(run('user', { key: 'A', value: '' }, ['create'])).rejects.toThrow(/不能为空/);
  });

  it('变量名、超长值、超长备注', async () => {
    await expect(run('user', { key: '1BAD', value: 'x' }, ['create'])).rejects.toThrow(/变量名/);
    await expect(run('user', { key: 'OK', value: 'x'.repeat(2049) }, ['create'])).rejects.toThrow(/2048/);
    await expect(run('user', { key: 'OK', value: 'x', note: '备'.repeat(257) }, ['create'])).rejects.toThrow(/256/);
  });

  it('update 没有任何字段、id 非法、工作区路径缺失', async () => {
    await expect(run('user', { id: '1' }, ['update'])).rejects.toThrow(/至少需要一个待修改字段/);
    await expect(run('user', { id: '0' }, ['delete'])).rejects.toThrow(/正整数/);
    await expect(run('user', { id: '1.5', note: 'a' }, ['update'])).rejects.toThrow(/正整数/);
    await expect(run('workspace', {}, ['list'])).rejects.toThrow(/workspace/);
    await expect(run('workspace', { key: 'A', value: 'x' }, ['create'])).rejects.toThrow(/workspace/);
  });

  it('value-file 读不到、未知子命令、多余参数', async () => {
    await expect(run('user', { key: 'A', 'value-file': '/no/such/env-value' }, ['create'])).rejects.toThrow(/无法读取/);
    await expect(run('nope', {}, [])).rejects.toThrow(/未知 env 子命令/);
    await expect(run('user', {}, ['list', 'extra'])).rejects.toThrow(/多余参数/);
    await expect(run('effective', { 'session-id': '1' }, ['list'])).rejects.toThrow(/没有子操作/);
    await expect(run('user-of', {}, [])).rejects.toThrow(/user-id/);
  });
});

describe('mao env 已挂到 CLI', () => {
  it('帮助列出 env，dispatch 打到用户层列表', async () => {
    const httpPath = path.join(LIB, 'http.js');
    const cmdPath = path.join(LIB, 'commands', 'env.js');
    const cliPath = path.join(LIB, 'cli.js');
    delete req.cache[httpPath];
    delete req.cache[cmdPath];
    delete req.cache[cliPath];
    const calls: RequestCall[] = [];
    const http = req(httpPath) as { request: (o: RequestCall) => Promise<unknown> };
    http.request = async (opts: RequestCall) => {
      calls.push(opts);
      return { code: 0, message: 'ok', data: [] };
    };
    const cli = req(cliPath) as { run: (argv: string[]) => Promise<void>; GLOBAL_HELP: string };
    expect(cli.GLOBAL_HELP).toContain('\n  env             三级 Shell 环境变量');

    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write);
    try {
      await cli.run(['env', 'user', 'list', '--base-url', 'https://mao.example.com', '--token', 't', '--json']);
    } finally {
      spy.mockRestore();
      delete req.cache[cliPath];
      delete req.cache[cmdPath];
      delete req.cache[httpPath];
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/user/env-variables',
      baseUrl: 'https://mao.example.com',
      token: 't',
    });
  });
});
