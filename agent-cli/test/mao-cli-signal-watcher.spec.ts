import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * mao-cli signal-watcher 模块回归（新功能，非 bugcheck）。
 *
 * 覆盖：
 * - 成功路径：create 补默认值 / 全字段 / 请求头两种写法 / --prompt 别名 / --body-file；
 *   update 只发显式字段（含 --headers '{}' 清空语义）；status / checks / admin-list / get /
 *   delete / test 的 method+path+query+body 形状与后端 watcher.routes.ts 对齐。
 * - 失败与缺参：create 必填缺失、枚举非法、POST 缺体、GET 带体、间隔越界、
 *   JSON_FIELD 缺路径 / 与 HASH 矛盾、请求头非法 JSON 与禁改头、copyFrom 非正、
 *   status 传 DISABLED、id 非正、分页非法、未知子命令。
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

type RequestCall = {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  token?: string;
  baseUrl?: string;
};
type SignalModule = { handle: (ctx: unknown) => Promise<void>; HELP: string };

/** 重新加载 http.js 与命令模块，把 request 换成记录调用的桩。 */
function loadModule(calls: RequestCall[]): SignalModule {
  const httpPath = path.join(LIB, 'http.js');
  const cmdPath = path.join(LIB, 'commands', 'signal-watcher.js');
  delete req.cache[httpPath];
  delete req.cache[cmdPath];
  const http = req(httpPath) as { request: (o: unknown) => Promise<unknown> };
  http.request = async (opts: RequestCall) => {
    calls.push(opts);
    return { code: 0, message: 'ok', data: { id: 1 } };
  };
  return req(cmdPath) as SignalModule;
}

async function run(subcommand: string, flags: Record<string, unknown>): Promise<{ out: string; calls: RequestCall[] }> {
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
      rest: [],
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
  return calls[0];
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mao signal-watcher 成功路径', () => {
  it('create 只传必填项时补齐后端默认值', async () => {
    const { calls } = await run('create', {
      name: '汇率监控',
      'agent-id': '7',
      url: 'https://api.example.com/rate',
      'prompt-template': '汇率变化: {diff}',
    });
    const call = expectCall(calls, { method: 'POST', path: '/signal-watchers' });
    expect(call.body).toEqual({
      name: '汇率监控',
      agentId: 7,
      url: 'https://api.example.com/rate',
      promptTemplate: '汇率变化: {diff}',
      method: 'GET',
      intervalMinutes: 30,
      compareMode: 'HASH',
      triggerMode: 'NEW_SESSION',
    });
  });

  it('create 全字段（含请求头对象 / jsonPath / copyFrom / triggerMode）', async () => {
    const { calls } = await run('create', {
      name: '库存',
      'agent-id': '3',
      url: 'https://api.example.com/stock',
      'prompt-template': '库存变化 {url} {diff}',
      method: 'post',
      headers: '{"Authorization":"Bearer t","X-Tag":"a"}',
      body: '{"q":1}',
      interval: '15',
      'compare-mode': 'json_field',
      'json-path': 'data.list.0.price',
      'trigger-mode': 'reuse_session',
      'copy-from': '9',
    });
    const call = expectCall(calls, { method: 'POST', path: '/signal-watchers' });
    expect(call.body).toEqual({
      name: '库存',
      agentId: 3,
      url: 'https://api.example.com/stock',
      promptTemplate: '库存变化 {url} {diff}',
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'X-Tag': 'a' },
      body: '{"q":1}',
      intervalMinutes: 15,
      compareMode: 'JSON_FIELD',
      jsonPath: 'data.list.0.price',
      triggerMode: 'REUSE_SESSION',
      copyFrom: 9,
    });
  });

  it('create 请求头接受 [{key,value}] 数组写法', async () => {
    const { calls } = await run('create', {
      name: 'n',
      'agent-id': '1',
      url: 'https://api.example.com/x',
      prompt: 'p',
      headers: '[{"key":"X-Token","value":"v"},{"key":" ","value":"skip"}]',
    });
    expect(calls[0].body).toMatchObject({ headers: { 'X-Token': 'v' } });
  });

  it('create --body-file 从文件读请求体', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-signal-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'body.json');
    fs.writeFileSync(file, '{"from":"file"}', 'utf8');
    const { calls } = await run('create', {
      name: 'n',
      'agent-id': '1',
      url: 'https://api.example.com/x',
      prompt: 'p',
      method: 'POST',
      'body-file': file,
    });
    expect(calls[0].body).toMatchObject({ method: 'POST', body: '{"from":"file"}' });
  });

  it('update 只发显式传入的字段，不补默认值', async () => {
    const { calls } = await run('update', { id: '5', interval: '60' });
    const call = expectCall(calls, { method: 'PUT', path: '/signal-watchers/5' });
    expect(call.body).toEqual({ intervalMinutes: 60 });
  });

  it('update --headers 空对象即显式清空请求头', async () => {
    const { calls } = await run('update', { id: '5', headers: '{}' });
    expect(calls[0].body).toEqual({ headers: {} });
  });

  it('update --body 空串即显式清空请求体', async () => {
    const { calls } = await run('update', { id: '5', body: '' });
    expect(calls[0].body).toEqual({ body: '' });
  });

  it('status 归一化大小写并只发 ACTIVE/PAUSED', async () => {
    const { calls } = await run('status', { id: '2', status: 'paused' });
    const call = expectCall(calls, { method: 'POST', path: '/signal-watchers/2/status' });
    expect(call.body).toEqual({ status: 'PAUSED' });
  });

  it('checks 带分页查询，默认 page=1 size=20', async () => {
    const { calls } = await run('checks', { id: '8' });
    expectCall(calls, { method: 'GET', path: '/signal-watchers/8/checks', query: { page: 1, size: 20 } });
  });

  it('checks 接受自定义分页', async () => {
    const { calls } = await run('checks', { id: '8', page: '2', size: '50' });
    expectCall(calls, { method: 'GET', path: '/signal-watchers/8/checks', query: { page: 2, size: 50 } });
  });

  it('admin-list 组装筛选查询', async () => {
    const { calls } = await run('admin-list', {
      page: '3',
      size: '10',
      status: 'disabled',
      'user-id': '42',
      'compare-mode': 'STATUS_CODE',
    });
    expectCall(calls, {
      method: 'GET',
      path: '/admin/signal-watchers',
      query: { page: 3, size: 10, status: 'DISABLED', userId: 42, compareMode: 'STATUS_CODE' },
    });
  });

  it('get / delete / test 的 method 与路径正确', async () => {
    const get = await run('get', { id: '11' });
    expectCall(get.calls, { method: 'GET', path: '/signal-watchers/11' });
    const del = await run('delete', { id: '11' });
    expectCall(del.calls, { method: 'DELETE', path: '/signal-watchers/11' });
    const test = await run('test', { id: '11' });
    expectCall(test.calls, { method: 'POST', path: '/signal-watchers/11/test' });
  });

  it('list 请求用户级清单', async () => {
    const { calls } = await run('list', {});
    expectCall(calls, { method: 'GET', path: '/signal-watchers' });
  });

  it('stdout 只输出接口 data，不含 token', async () => {
    const { out } = await run('create', {
      name: 'n',
      'agent-id': '1',
      url: 'https://api.example.com/x',
      prompt: 'p',
    });
    expect(out).toContain('"id"');
    expect(out).not.toContain('test-token');
  });
});

describe('mao signal-watcher 失败与缺参', () => {
  it('create 缺必填项时报出缺失的参数名', async () => {
    await expect(run('create', { name: 'n', url: 'https://api.example.com/x' }))
      .rejects.toThrow(/create 缺少必填参数.*agent-id.*prompt-template/);
  });

  it('create 拒绝非法 compare-mode', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', 'compare-mode': 'MD5',
    })).rejects.toThrow(/--compare-mode 必须是 HASH \/ JSON_FIELD \/ STATUS_CODE/);
  });

  it('create POST 必须带请求体', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', method: 'POST',
    })).rejects.toThrow(/POST 方法必须填写请求体/);
  });

  it('create GET 带请求体被拒（后端会静默丢弃）', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', body: 'x',
    })).rejects.toThrow(/GET 方法不带请求体/);
  });

  it('create 间隔越界与非整数被拒', async () => {
    const base = { name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p' };
    await expect(run('create', { ...base, interval: '0' })).rejects.toThrow(/--interval 需为 1~1440/);
    await expect(run('create', { ...base, interval: '1441' })).rejects.toThrow(/--interval 需为 1~1440/);
    await expect(run('create', { ...base, interval: '1.5' })).rejects.toThrow(/--interval 需为 1~1440/);
  });

  it('create JSON_FIELD 必须带 json-path', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', 'compare-mode': 'JSON_FIELD',
    })).rejects.toThrow(/JSON_FIELD 模式必须填写提取路径/);
  });

  it('create 非 JSON_FIELD 模式带 json-path 被拒', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', 'json-path': 'a.b',
    })).rejects.toThrow(/--json-path 仅在 --compare-mode JSON_FIELD 下生效/);
  });

  it('update 切换 JSON_FIELD 时传空路径被拒', async () => {
    await expect(run('update', { id: '5', 'compare-mode': 'JSON_FIELD', 'json-path': '' }))
      .rejects.toThrow(/JSON_FIELD 模式必须填写提取路径/);
  });

  it('请求头非法 JSON 被拒', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', headers: 'not-json',
    })).rejects.toThrow(/--headers 必须是合法 JSON/);
  });

  it('禁改的请求头（host）被拒', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', headers: '{"Host":"evil.com"}',
    })).rejects.toThrow(/请求头 Host 不允许覆盖/);
  });

  it('copyFrom 非正整数被拒', async () => {
    await expect(run('create', {
      name: 'n', 'agent-id': '1', url: 'https://api.example.com/x', prompt: 'p', 'copy-from': '0',
    })).rejects.toThrow(/--copy-from 必须为正整数/);
  });

  it('update 未传任何待改字段被拒', async () => {
    await expect(run('update', { id: '5' })).rejects.toThrow(/update 至少需要一个待修改字段/);
  });

  it('status 拒绝 DISABLED（系统终态只能经 ACTIVE 恢复）', async () => {
    await expect(run('status', { id: '5', status: 'DISABLED' }))
      .rejects.toThrow(/--status 必须是 ACTIVE \/ PAUSED/);
  });

  it('status 缺 --status 被拒', async () => {
    await expect(run('status', { id: '5' })).rejects.toThrow(/缺少必填参数 --status/);
  });

  it('id 非正整数被拒', async () => {
    await expect(run('get', { id: '0' })).rejects.toThrow(/--id 必须为正整数/);
    await expect(run('get', {})).rejects.toThrow(/缺少必填参数 --id/);
  });

  it('分页参数非法被拒', async () => {
    await expect(run('checks', { id: '5', size: '101' })).rejects.toThrow(/--size 必须为 1~100/);
    await expect(run('checks', { id: '5', page: '0' })).rejects.toThrow(/--page 必须为正整数/);
  });

  it('未知子命令报错并带用法', async () => {
    await expect(run('frobnicate', {})).rejects.toThrow(/未知 signal-watcher 子命令: frobnicate/);
  });
});
