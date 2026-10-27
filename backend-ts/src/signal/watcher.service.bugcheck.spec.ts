import { describe, expect, it, vi } from 'vitest';
import type { SignalWatcher, SignalWatcherCheck } from './types.js';
import type { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal.repository.js';
import { SignalSecretCipher } from './signal-cipher.js';
import type { ProbeResult } from './probe-client.js';
import { WatcherService, WATCHER_DISABLE_AFTER_FAILURES } from './watcher.service.js';

/**
 * BUG（产品层后果）：JSON_FIELD 哨兵的 jsonPath 命中 Object.prototype 成员时，
 * 轮询不失败、不停用、不触发——静默按 sha256('') 建基线。
 *
 * 根因在 watcher.logic.ts `extractJsonPath` 用 `in` 判定路径段（命中原型链），
 * 详见 watcher.logic.bugcheck.spec.ts。本 spec 验证该根因在 runCheck 主流程上的
 * 可观测行为：
 *
 *   期望：computeValueHash 抛 ProbeValueError → check 行落 error、计入连败
 *         （recordFailure），不写基线；
 *   实际：不抛错 → updateHash(sha256('')) → markChecked 建基线，
 *         recordFailure 一次都不调用，轮询记录显示完全正常。
 *
 * 触发条件：compareMode=JSON_FIELD 且 jsonPath 为 toString / constructor /
 * valueOf / hasOwnProperty 等原型成员名（响应体是合法 JSON 即可）。
 */

const SECRET = 'test-signal-secret';

function watcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id: 1,
    userId: 7,
    agentId: 3,
    name: 'proto-path-watcher',
    url: 'https://example.com/api',
    method: 'GET',
    headersJson: null,
    body: null,
    intervalMinutes: 15,
    compareMode: 'JSON_FIELD',
    jsonPath: 'toString',
    promptTemplate: 'changed {diff}',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    triggerMode: 'NEW_SESSION',
    reuseSessionId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

interface Harness {
  service: WatcherService;
  checks: SignalWatcherCheck[];
  markChecked: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
}

function harness(initial: SignalWatcher, body = '{}'): Harness {
  const watchers = new Map<number, SignalWatcher>([[initial.id!, initial]]);
  const checks: SignalWatcherCheck[] = [];
  const nextCheckId = { value: 100 };
  const failureState = new Map<number, { consecutiveFailures: number; status: string }>();

  const probeExecute = vi.fn(async (): Promise<ProbeResult> => ({
    ok: true,
    httpStatus: 200,
    body,
    bodyBytes: Buffer.from(body, 'utf8'),
    error: null,
    durationMs: 5,
  }));
  const openRun = { run: vi.fn(async () => ({ sessionId: 42, messageId: 1, queued: false, terminalPhase: 'COMPLETED' as const })) };
  const markChecked = vi.fn(async (id: number, patch: { lastValueHash: string | null; lastValueSnippet: string | null; lastChangedAt: string | null; consecutiveFailures: number }) => {
    const row = watchers.get(id);
    if (row == null) return;
    row.lastValueHash = patch.lastValueHash;
    row.lastValueSnippet = patch.lastValueSnippet;
    row.lastChangedAt = patch.lastChangedAt;
    // 与真实 SQL 一致：仅当库内值仍等于本次读到的快照值时才清零
    if (row.consecutiveFailures === patch.consecutiveFailures) row.consecutiveFailures = 0;
  });
  // 与真实 SQL 语义一致：失败状态放独立槽位，不改调用方持有的更新前快照。
  const recordFailure = vi.fn(async (id: number, _backoff: number, _threshold: number) => {
    const snapshot = watchers.get(id);
    if (snapshot == null || snapshot.status !== 'ACTIVE') return null;
    const prev = failureState.get(id) ?? { consecutiveFailures: snapshot.consecutiveFailures, status: snapshot.status };
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const status = consecutiveFailures >= WATCHER_DISABLE_AFTER_FAILURES ? 'DISABLED' : 'ACTIVE';
    failureState.set(id, { consecutiveFailures, status });
    return { ...snapshot, consecutiveFailures, status };
  });

  const watcherRepo = {
    findById: vi.fn(async (id: number) => {
      const row = watchers.get(id);
      return row == null ? null : { ...row };
    }),
    markChecked,
    recordFailure,
  };
  const checkRepo = {
    insert: vi.fn(async (row: Omit<SignalWatcherCheck, 'id'>) => {
      const id = nextCheckId.value;
      nextCheckId.value += 1;
      checks.push({ ...row, id } as SignalWatcherCheck);
      return id;
    }),
    updateHash: vi.fn(async (id: number, hash: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.valueHash = hash;
    }),
    markChanged: vi.fn(async (id: number) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.changed = 1;
    }),
    markTriggered: vi.fn(async (id: number, sessionId: number) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.triggeredSessionId = sessionId;
    }),
    markWarning: vi.fn(async (id: number, warning: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.warning = warning;
    }),
    markError: vi.fn(async (id: number, error: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.error = error;
    }),
    remove: vi.fn(async () => undefined),
  };

  const service = new WatcherService({
    watcherRepo: watcherRepo as unknown as MysqlSignalWatcherRepository,
    checkRepo: checkRepo as unknown as MysqlSignalCheckRepository,
    cipher: new SignalSecretCipher(SECRET),
    openRun: openRun as never,
    probe: { execute: probeExecute as never },
    // 复用指针预检依赖（本文件 fixture 均为 NEW_SESSION，不会被调用）
    getSession: vi.fn(async () => null),
  });

  return { service, checks, markChecked, recordFailure };
}

describe('BUG：JSON_FIELD 路径命中原型链成员时，轮询静默建基线而非计失败', () => {
  it('jsonPath=toString：应按取值失败计入连败并落 error，而不是写基线', async () => {
    const h = harness(watcher({ jsonPath: 'toString' }));
    await h.service.runCheck(1);

    // 期望：路径段不存在 → ProbeValueError → recordFailure（连败 +1）
    expect(h.recordFailure, '取值失败必须计入连败（否则配置错误的哨兵永远不会自动停用）').toHaveBeenCalledTimes(1);
    // 期望：check 行带失败原因
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.error, 'check 行必须记录失败原因').toMatch(/toString/);
    // 期望：失败轮次不写基线
    expect(h.markChecked, '取值失败的轮次不得建立基线').not.toHaveBeenCalled();
  });

  it('jsonPath=data.constructor：嵌套段命中原型链同样计失败', async () => {
    const h = harness(watcher({ jsonPath: 'data.constructor' }), '{"data":{"v":1}}');
    await h.service.runCheck(1);
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.checks[0]!.error).toMatch(/constructor/);
  });

  it('对照组：jsonPath 指向真实字段时正常建基线、不计失败（修复不得误伤）', async () => {
    const h = harness(watcher({ jsonPath: 'v' }), '{"v":"1"}');
    await h.service.runCheck(1);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.markChecked).toHaveBeenCalledTimes(1);
    expect(h.checks[0]!.error).toBeNull();
  });
});
