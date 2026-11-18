import { describe, expect, it, vi } from 'vitest';
import { CreateSignalWatcherTool, ListSignalWatchersTool } from './signal-watcher-tools.js';

/**
 * 每个用例独立 mock（工厂）：create/list 的调用历史与 getSession 的 Once 队列
 * 不跨用例泄漏——共享 spy 会把上一用例的调用算进下一用例的断言。
 */

function makeWatcherService() {
  return {
    list: vi.fn(async () => [
      {
        id: 9, name: '汇率', agentId: 5, url: 'https://example.com/rate', method: 'GET',
        headers: { Authorization: '******' }, hasBody: false, bodyLength: 0,
        intervalMinutes: 30, compareMode: 'HASH', jsonPath: null, promptTemplate: 'p',
        probeType: 'HTTP', scriptPath: null, scriptTimeoutSeconds: null, status: 'ACTIVE',
        lastValueHash: null, lastCheckedAt: null, lastChangedAt: null, consecutiveFailures: 0,
        triggerMode: 'NEW_SESSION', reuseSessionId: null, lastValueSnippet: null,
        lastChangeOldSnippet: null, lastChangeNewSnippet: null, createdAt: null,
      },
      {
        id: 10, name: '磁盘', agentId: 5, url: '', method: 'GET',
        headers: {}, hasBody: false, bodyLength: 0,
        intervalMinutes: 10, compareMode: 'JSON_FIELD', jsonPath: 'free', promptTemplate: 'p',
        probeType: 'SCRIPT', scriptPath: 'ops/sentinels/disk.sh', scriptTimeoutSeconds: 60, status: 'ACTIVE',
        lastValueHash: null, lastCheckedAt: null, lastChangedAt: null, consecutiveFailures: 0,
        triggerMode: 'NEW_SESSION', reuseSessionId: null, lastValueSnippet: null,
        lastChangeOldSnippet: null, lastChangeNewSnippet: null, createdAt: null,
      },
    ]),
    create: vi.fn(async (_userId: number, input: { triggerMode?: string; specifiedSessionId?: number | null }) => ({
      id: 11, name: '磁盘', agentId: 5, url: '', method: 'GET', headers: {}, hasBody: false,
      bodyLength: 0, intervalMinutes: 10, compareMode: 'JSON_FIELD', jsonPath: 'free',
      promptTemplate: 'p', probeType: 'SCRIPT', scriptPath: 'ops/sentinels/disk.sh',
      scriptTimeoutSeconds: 60, status: 'ACTIVE', lastValueHash: null, lastCheckedAt: null,
      lastChangedAt: null, consecutiveFailures: 0,
      // 回显入参触发方式（真实 create 的返回值随 normalized 走），供结果 JSON 断言
      triggerMode: input.triggerMode ?? 'NEW_SESSION',
      specifiedSessionId: input.specifiedSessionId ?? null,
      reuseSessionId: null, lastValueSnippet: null, lastChangeOldSnippet: null,
      lastChangeNewSnippet: null, createdAt: null,
    })),
  };
}

function makeSessions(session: {
  id: number; agentId: number; userId: number;
  sessionType?: string | null; executionMode?: string | null; status?: string | null;
} | null = { id: 21, agentId: 5, userId: 7, sessionType: null, executionMode: 'CLOUD', status: null }) {
  return { getSession: vi.fn(async () => session) };
}

describe('SignalWatcherTools', () => {
  it('list_signal_watchers 输出结构性字段且不含敏感请求头', async () => {
    const watcherService = makeWatcherService();
    const list = new ListSignalWatchersTool(() => watcherService as never, makeSessions() as never);
    expect(list.getName()).toBe('list_signal_watchers');
    const out = JSON.parse(await list.execute('{}', 21, 7, null));
    expect(out.total).toBe(2);
    expect(out.watchers[0]).toMatchObject({ watcher_id: 9, probe_type: 'HTTP', target: 'GET https://example.com/rate' });
    expect(out.watchers[1]).toMatchObject({ watcher_id: 10, probe_type: 'SCRIPT', target: 'ops/sentinels/disk.sh', interval_minutes: 10 });
    // 敏感请求头一律不透出
    expect(JSON.stringify(out)).not.toContain('Authorization');
    expect(JSON.stringify(out)).not.toContain('******');
    // 未在会话上下文（无 userId 可解析）时报错而非崩溃
    expect(JSON.parse(await list.execute('{}', null, null, null)).error).toContain('用户');
  });

  it('create_signal_watcher SCRIPT：解析会话属主与 Agent，透传脚本字段', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    expect(create.getName()).toBe('create_signal_watcher');
    const out = JSON.parse(await create.execute(JSON.stringify({
      name: '磁盘',
      probe_type: 'SCRIPT',
      script_path: 'ops/sentinels/disk.sh',
      compare_mode: 'JSON_FIELD',
      json_path: 'free',
      interval_minutes: 10,
      timeout_seconds: 45,
      prompt_template: '磁盘水位变化 {diff}',
    }), 21, 7, null));
    expect(out.success).toBe(true);
    expect(out.watcher_id).toBe(11);
    expect(watcherService.create).toHaveBeenCalledTimes(1);
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      agentId: 5,
      probeType: 'SCRIPT',
      scriptPath: 'ops/sentinels/disk.sh',
      scriptTimeoutSeconds: 45,
      intervalMinutes: 10,
      compareMode: 'JSON_FIELD',
      jsonPath: 'free',
      promptTemplate: '磁盘水位变化 {diff}',
    }));
  });

  it('create_signal_watcher：SCRIPT 缺 script_path 被拦截，错误提示先写脚本', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    const out = JSON.parse(await create.execute(JSON.stringify({
      name: '磁盘', probe_type: 'SCRIPT', compare_mode: 'HASH', interval_minutes: 10, prompt_template: 'p',
    }), 21, 7, null));
    expect(out.error).toContain('script_path');
    expect(watcherService.create).not.toHaveBeenCalled();
  });

  it('create_signal_watcher：服务层校验异常转为 errorJson（如脚本不存在）', async () => {
    const watcherService = makeWatcherService();
    watcherService.create.mockRejectedValueOnce(new Error('脚本文件不存在：ops/sentinels/disk.sh（请先在工作区上传或让 Agent 编写）'));
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    const out = JSON.parse(await create.execute(JSON.stringify({
      name: '磁盘', probe_type: 'SCRIPT', script_path: 'ops/sentinels/disk.sh',
      compare_mode: 'HASH', interval_minutes: 10, prompt_template: 'p',
    }), 21, 7, null));
    expect(out.error).toContain('脚本文件不存在');
  });

  it('create_signal_watcher：无会话上下文（无 userId/agentId）报错', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions(null) as never);
    const out = JSON.parse(await create.execute(JSON.stringify({
      name: '磁盘', probe_type: 'SCRIPT', script_path: 'p.sh', compare_mode: 'HASH',
      interval_minutes: 10, prompt_template: 'p',
    }), null, null, null));
    expect(out.error).toContain('用户');
    expect(watcherService.create).not.toHaveBeenCalled();
  });

  it('create_signal_watcher：HTTP 透传 url/method/headers/body', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    await create.execute(JSON.stringify({
      name: '汇率', probe_type: 'HTTP', url: 'https://example.com/rate', method: 'POST',
      headers: { 'X-Api-Key': 'k1' }, body: '{}', compare_mode: 'STATUS_CODE',
      interval_minutes: 15, prompt_template: 'p',
    }), 21, 7, null);
    expect(watcherService.create).toHaveBeenCalledTimes(1);
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      probeType: 'HTTP',
      url: 'https://example.com/rate',
      method: 'POST',
      headers: { 'X-Api-Key': 'k1' },
      body: '{}',
    }));
  });

  it('工具描述护栏：仅响应用户直接表达的需求、脚本须先写入工作区', () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    expect(create.getDescription()).toContain('仅响应用户直接表达的哨兵配置需求');
    expect(create.getDescription()).toContain('禁止在自身任务执行中擅自创建');
    expect(create.getDescription()).toContain('先用文件工具');
    expect(create.getToolPrompt()).toContain('{diff}');
    const schema = create.getInputSchema().properties as Record<string, { description?: string }>;
    expect(schema.script_path?.description).toContain('相对路径');
    expect(schema.interval_minutes?.description).toContain('5~1440');
    expect(schema.trigger_mode?.description).toContain('SPECIFIED_SESSION');
    expect(schema.session_id?.description).toContain('当前会话');
  });
});

// ── 指定执行会话（V197，技术方案 2026-11-17 §4.6）────────────────────────────
// 默认值在工具代码内判定（模型无从得知 executionMode/sessionType）：当前会话可作触发
// 目标（主会话 + CLOUD + 未归档）则默认指定当前会话，否则回退 NEW_SESSION。回退不静默。
describe('CreateSignalWatcherTool 指定执行会话', () => {
  const baseArgs = {
    name: '汇率',
    probe_type: 'HTTP',
    url: 'https://example.com/rate',
    compare_mode: 'HASH',
    interval_minutes: 15,
    prompt_template: 'p',
  };

  function makeCreate() {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    return { watcherService, create };
  }

  it('默认：当前会话是主会话且 CLOUD → SPECIFIED_SESSION + 当前会话，结果透出 trigger_mode/execute_session_id', async () => {
    const { watcherService, create } = makeCreate();
    const out = JSON.parse(await create.execute(JSON.stringify(baseArgs), 21, 7, null));
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      triggerMode: 'SPECIFIED_SESSION',
      specifiedSessionId: 21,
    }));
    expect(out.trigger_mode).toBe('SPECIFIED_SESSION');
    expect(out.execute_session_id).toBe(21);
    expect(out.message).toContain('会话 #21');
  });

  it('默认：当前会话是 LOCAL → 回退 NEW_SESSION（结果写明实际方式）', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(
      () => watcherService as never,
      makeSessions({ id: 21, agentId: 5, userId: 7, sessionType: null, executionMode: 'LOCAL', status: null }) as never,
    );
    const out = JSON.parse(await create.execute(JSON.stringify(baseArgs), 21, 7, null));
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      triggerMode: 'NEW_SESSION',
      specifiedSessionId: null,
    }));
    expect(out.trigger_mode).toBe('NEW_SESSION');
    expect(out.execute_session_id).toBeNull();
  });

  it('默认：当前会话是边路任务 → 回退 NEW_SESSION', async () => {
    const watcherService = makeWatcherService();
    const create = new CreateSignalWatcherTool(
      () => watcherService as never,
      makeSessions({ id: 21, agentId: 5, userId: 7, sessionType: 'SIDE_TASK', executionMode: 'CLOUD', status: null }) as never,
    );
    const out = JSON.parse(await create.execute(JSON.stringify(baseArgs), 21, 7, null));
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({ triggerMode: 'NEW_SESSION' }));
    expect(out.trigger_mode).toBe('NEW_SESSION');
  });

  it('显式 trigger_mode=REUSE_SESSION：照用、不带指定会话', async () => {
    const { watcherService, create } = makeCreate();
    const out = JSON.parse(await create.execute(JSON.stringify({ ...baseArgs, trigger_mode: 'REUSE_SESSION' }), 21, 7, null));
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      triggerMode: 'REUSE_SESSION',
      specifiedSessionId: null,
    }));
    expect(out.trigger_mode).toBe('REUSE_SESSION');
    expect(out.execute_session_id).toBeNull();
  });

  it('显式 trigger_mode=SPECIFIED_SESSION 缺 session_id：默认当前会话', async () => {
    const { watcherService, create } = makeCreate();
    await create.execute(JSON.stringify({ ...baseArgs, trigger_mode: 'SPECIFIED_SESSION' }), 21, 7, null);
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      triggerMode: 'SPECIFIED_SESSION',
      specifiedSessionId: 21,
    }));
  });

  it('显式 session_id（未传 trigger_mode）：隐含指定模式 + 该会话', async () => {
    const { watcherService, create } = makeCreate();
    await create.execute(JSON.stringify({ ...baseArgs, session_id: 33 }), 21, 7, null);
    expect(watcherService.create).toHaveBeenCalledWith(7, expect.objectContaining({
      triggerMode: 'SPECIFIED_SESSION',
      specifiedSessionId: 33,
    }));
  });

  it('服务层校验失败（如会话已归档）原样转为 errorJson，不二次兜底', async () => {
    const watcherService = makeWatcherService();
    watcherService.create.mockRejectedValueOnce(new Error('指定会话已归档，请先恢复或重新选择'));
    const create = new CreateSignalWatcherTool(() => watcherService as never, makeSessions() as never);
    const out = JSON.parse(await create.execute(JSON.stringify({ ...baseArgs, session_id: 33 }), 21, 7, null));
    expect(out.error).toContain('指定会话已归档');
  });
});
