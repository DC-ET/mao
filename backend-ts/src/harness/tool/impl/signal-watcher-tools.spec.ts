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
    create: vi.fn(async () => ({
      id: 11, name: '磁盘', agentId: 5, url: '', method: 'GET', headers: {}, hasBody: false,
      bodyLength: 0, intervalMinutes: 10, compareMode: 'JSON_FIELD', jsonPath: 'free',
      promptTemplate: 'p', probeType: 'SCRIPT', scriptPath: 'ops/sentinels/disk.sh',
      scriptTimeoutSeconds: 60, status: 'ACTIVE', lastValueHash: null, lastCheckedAt: null,
      lastChangedAt: null, consecutiveFailures: 0, triggerMode: 'NEW_SESSION',
      reuseSessionId: null, lastValueSnippet: null, lastChangeOldSnippet: null,
      lastChangeNewSnippet: null, createdAt: null,
    })),
  };
}

function makeSessions(session: { id: number; agentId: number; userId: number } | null = { id: 21, agentId: 5, userId: 7 }) {
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
  });
});
