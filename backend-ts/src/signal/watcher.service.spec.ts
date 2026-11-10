import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { SignalWatcher, SignalWatcherCheck } from './types.js';
import type { MysqlSignalCheckRepository, MysqlSignalWatcherRepository } from './signal.repository.js';
import { SignalSecretCipher } from './signal-cipher.js';
import type { ProbeResult } from './probe-client.js';
import type { ScriptProbeResult } from './script-probe.js';
import { ScriptProbeInfrastructureError } from '../harness/container/container-script-probe.js';
import type { WatcherCredentialResolver } from './watcher-credential-resolver.js';
import {
  WATCHER_DISABLE_AFTER_FAILURES,
  WATCHER_MAX_TRIGGERS_PER_HOUR,
  WatcherService,
  type WatcherDisableNotifier,
  type WatcherInput,
  type WatcherSessionLookup,
} from './watcher.service.js';

const SECRET = 'test-signal-secret';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function makeCipher(): SignalSecretCipher {
  return new SignalSecretCipher(SECRET);
}

function watcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id: 1,
    userId: 7,
    agentId: 3,
    name: 'w',
    url: 'https://example.com/api',
    method: 'GET',
    headersJson: null,
    body: null,
    intervalMinutes: 15,
    compareMode: 'HASH',
    jsonPath: null,
    promptTemplate: 'changed {url} {name} {diff}',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastChangeOldSnippet: null,
    lastChangeNewSnippet: null,
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

function probeResult(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    ok: true,
    httpStatus: 200,
    body: 'body',
    bodyBytes: Buffer.from('body', 'utf8'),
    error: null,
    durationMs: 5,
    ...overrides,
  };
}

interface Harness {
  service: WatcherService;
  watchers: Map<number, SignalWatcher>;
  sessions: Map<number, WatcherSessionLookup>;
  checks: SignalWatcherCheck[];
  probeExecute: ReturnType<typeof vi.fn>;
  scriptProbeExecute: ReturnType<typeof vi.fn>;
  scriptProjectsRoot: string | null;
  openRun: { run: ReturnType<typeof vi.fn> };
  notify: ReturnType<typeof vi.fn>;
  markChecked: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  getSession: ReturnType<typeof vi.fn>;
  nextCheckId: { value: number };
}

function harness(options: {
  watcher?: SignalWatcher;
  probe?: () => Promise<ProbeResult> | ProbeResult;
  /** 脚本探针假执行器返回值（V189）；提供即视为装配了脚本探针依赖。 */
  scriptProbe?: () => Promise<ScriptProbeResult> | ScriptProbeResult;
  /** 脚本存储根（真实临时目录）；与 scriptProbe 一起提供。 */
  scriptProjectsRoot?: string;
  /** 复用指针预检可见的会话；缺省给一条「本人 + CLOUD + agent 3」的可用会话（id=42）。 */
  sessions?: WatcherSessionLookup[];
  /** 覆盖 getSession 行为，用于复刻生产 wiring（行不存在时抛 SESSION_NOT_FOUND）。 */
  getSession?: (id: number) => Promise<WatcherSessionLookup | null>;
  /** 凭据占位符 resolver（缺省不传 = 未装配路径）。 */
  credentialResolver?: WatcherCredentialResolver | null;
  /** Docker 模式脚本探针桥。缺省不装配，脚本走宿主执行器。 */
  containerScriptProbe?: {
    enabledFor(userId: number): Promise<boolean>;
    execute(input: { userId: number; agentId: number; scriptPath: string; timeoutSeconds: number; env: Record<string, string> }): Promise<ScriptProbeResult>;
  };
} = {}): Harness {
  const watchers = new Map<number, SignalWatcher>();
  const initial = options.watcher ?? watcher();
  watchers.set(initial.id!, initial);
  const sessions = new Map<number, WatcherSessionLookup>();
  for (const s of options.sessions ?? [{ id: 42, userId: 7, sessionType: null, executionMode: 'CLOUD', agentId: 3 }]) {
    sessions.set(s.id!, s);
  }
  const checks: SignalWatcherCheck[] = [];
  const nextCheckId = { value: 100 };

  const probeExecute = vi.fn(async () => (options.probe ? options.probe() : probeResult()));
  const scriptProbeExecute = vi.fn(async () =>
    options.scriptProbe ? options.scriptProbe() : { ok: true, exitCode: 0, stdout: '', stdoutBytes: Buffer.alloc(0), error: null, durationMs: 5 },
  );
  const openRun = { run: vi.fn(async () => ({ sessionId: 42, messageId: 1, queued: false, terminalPhase: 'COMPLETED' as const })) };
  // 复用指针预检：读不到返回 null（等同会话已删）
  const getSession = options.getSession
    ? vi.fn(options.getSession)
    : vi.fn(async (id: number) => sessions.get(id) ?? null);
  const notify = vi.fn(async () => undefined);
  // 与真实 SQL 语义一致：只在「库内值仍等于本次传入的快照值」时才清零，
  // 库内被并发失败推高时保留原值（BUG-N/BUG-G 的真实行为）。
  const markChecked = vi.fn(async (id: number, patch: { lastValueHash: string | null; lastValueSnippet: string | null; lastChangedAt: string | null; consecutiveFailures: number; resetFailures?: boolean }) => {
    const row = watchers.get(id);
    if (row == null) return;
    row.lastValueHash = patch.lastValueHash;
    row.lastValueSnippet = patch.lastValueSnippet;
    if ('lastChangeOldSnippet' in patch) row.lastChangeOldSnippet = patch.lastChangeOldSnippet ?? null;
    if ('lastChangeNewSnippet' in patch) row.lastChangeNewSnippet = patch.lastChangeNewSnippet ?? null;
    row.lastChangedAt = patch.lastChangedAt;
    if (patch.resetFailures !== false && row.consecutiveFailures === patch.consecutiveFailures) row.consecutiveFailures = 0;
  });
  // 真实 recordFailure 是「单条 UPDATE 后重新读行」：失败状态放在独立槽位，
  // 且绝不改调用方持有的更新前快照（否则「是否刚从 ACTIVE 变 DISABLED」判定失效）。
  const failureState = new Map<number, { consecutiveFailures: number; status: string }>();
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
    insert: vi.fn(async (row: Omit<SignalWatcher, 'id'>) => {
      const id = watchers.size + 1;
      watchers.set(id, { ...row, id } as SignalWatcher);
      return id;
    }),
    // 真实 DB 每次读都是新行快照（不是同一对象引用）：返回副本，
    // 否则「探针在途期间库里被并发改写」这类场景在 fake 上无法表达。
    findById: vi.fn(async (id: number) => {
      const row = watchers.get(id);
      return row == null ? null : { ...row };
    }),
    findOwned: vi.fn(async (id: number, userId: number) => {
      const row = watchers.get(id);
      return row != null && row.userId === userId ? row : null;
    }),
    listByUser: vi.fn(async (userId: number) => [...watchers.values()].filter((w) => w.userId === userId)),
    listForAdmin: vi.fn(async () => ({ rows: [...watchers.values()], total: watchers.size })),
    update: vi.fn(async (id: number, _userId: number, patch: Partial<SignalWatcher>) => {
      const row = watchers.get(id);
      if (row == null) return false;
      Object.assign(row, patch);
      return true;
    }),
    listDue: vi.fn(async () => [...watchers.values()].filter((w) => w.status === 'ACTIVE')),
    markChecked,
    recordFailure,
    touchChecked: vi.fn(async (id: number) => {
      const row = watchers.get(id);
      if (row == null || row.status !== 'ACTIVE') return false;
      row.lastCheckedAt = '2026-11-10 13:00:00';
      return true;
    }),
    delete: vi.fn(async (id: number) => { watchers.delete(id); return true; }),
  };

  const checkRepo = {
    insert: vi.fn(async (row: Omit<SignalWatcherCheck, 'id'>) => {
      const id = nextCheckId.value;
      nextCheckId.value += 1;
      checks.push({ ...row, id } as SignalWatcherCheck);
      return id;
    }),
    markTriggered: vi.fn(async (id: number, sessionId: number) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.triggeredSessionId = sessionId;
    }),
    updateHash: vi.fn(async (id: number, hash: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.valueHash = hash;
    }),
    updateValue: vi.fn(async (id: number, patch: { valueHash: string; oldValueSnippet: string | null; newValueSnippet: string | null }) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) { row.valueHash = patch.valueHash; row.oldValueSnippet = patch.oldValueSnippet; row.newValueSnippet = patch.newValueSnippet; }
    }),
    markChanged: vi.fn(async (id: number) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.changed = 1;
    }),
    markWarning: vi.fn(async (id: number, warning: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.warning = warning;
    }),
    markError: vi.fn(async (id: number, error: string) => {
      const row = checks.find((c) => c.id === id);
      if (row != null) row.error = error;
    }),
    remove: vi.fn(async (id: number) => {
      const index = checks.findIndex((c) => c.id === id);
      if (index >= 0) checks.splice(index, 1);
    }),
    listByWatcher: vi.fn(async (watcherId: number) => checks.filter((c) => c.watcherId === watcherId)),
    countByWatcher: vi.fn(async (watcherId: number) => checks.filter((c) => c.watcherId === watcherId).length),
    countRecentTriggers: vi.fn(async (watcherId: number) =>
      checks.filter((c) => c.watcherId === watcherId && c.triggeredSessionId != null).length),
    deleteByWatcher: vi.fn(async (watcherId: number) => {
      const removed = checks.filter((c) => c.watcherId === watcherId).length;
      for (let i = checks.length - 1; i >= 0; i -= 1) {
        if (checks[i]!.watcherId === watcherId) checks.splice(i, 1);
      }
      return removed;
    }),
    deleteBatch: vi.fn(async () => 0),
  };

  const service = new WatcherService({
    watcherRepo: watcherRepo as unknown as MysqlSignalWatcherRepository,
    checkRepo: checkRepo as unknown as MysqlSignalCheckRepository,
    cipher: makeCipher(),
    openRun: openRun as never,
    probe: { execute: probeExecute as never },
    scriptProbe: { execute: scriptProbeExecute as never },
    scriptProjectsRoot: options.scriptProjectsRoot != null
      ? (userId: number) => join(options.scriptProjectsRoot!, String(userId), 'projects')
      : undefined,
    scriptUserHome: () => null,
    disableNotifier: { notifyWatcherDisabled: notify } satisfies WatcherDisableNotifier,
    getSession,
    credentialResolver: options.credentialResolver,
    containerScriptProbe: options.containerScriptProbe as never,
  });

  return { service, watchers, sessions, checks, probeExecute, scriptProbeExecute, scriptProjectsRoot: options.scriptProjectsRoot ?? null, openRun, notify, markChecked, recordFailure, getSession, nextCheckId };
}

const baseInput: WatcherInput = {
  name: 'w',
  agentId: 3,
  url: 'https://example.com/api',
  method: 'GET',
  headers: null,
  body: null,
  intervalMinutes: 15,
  compareMode: 'HASH',
  jsonPath: null,
  promptTemplate: 'changed {diff}',
};

describe('WatcherService CRUD', () => {
  it('creates a watcher and returns a masked view', async () => {
    const h = harness();
    const view = await h.service.create(7, { ...baseInput, headers: { Authorization: 'Bearer t', Accept: 'application/json' } });
    expect(view.id).toBeGreaterThan(0);
    expect(view.status).toBe('ACTIVE');
    expect(view.headers.Authorization).toBe('******');
    expect(view.headers.Accept).toBe('application/json');
    // 落库的是密文，不是明文
    const stored = h.watchers.get(view.id)!;
    expect(stored.headersJson).not.toContain('Bearer t');
    expect(stored.lastValueHash).toBeNull();
  });

  it('creates watchers without a per-user cap (上限已取消)', async () => {
    // 决策：取消 MAX_WATCHERS_PER_USER；这里锁定「第 21 个也放行」不回归
    const h = harness();
    for (let i = 2; i <= 21; i += 1) {
      await h.service.create(7, { ...baseInput, name: `w${i}` });
    }
    expect([...h.watchers.values()].filter((w) => w.userId === 7)).toHaveLength(21);
  });

  it('validates url, interval, mode, path and template', async () => {
    const h = harness();
    await expect(h.service.create(7, { ...baseInput, url: 'http://127.0.0.1/x' })).rejects.toThrow(/私网/);
    await expect(h.service.create(7, { ...baseInput, intervalMinutes: 0 })).rejects.toThrow(/间隔/);
    await expect(h.service.create(7, { ...baseInput, intervalMinutes: 1441 })).rejects.toThrow(/间隔/);
    await expect(h.service.create(7, { ...baseInput, compareMode: 'NOPE' })).rejects.toThrow(/判定模式/);
    await expect(h.service.create(7, { ...baseInput, compareMode: 'JSON_FIELD' })).rejects.toThrow(/提取路径/);
    await expect(h.service.create(7, { ...baseInput, promptTemplate: '' })).rejects.toThrow(/提示词/);
    await expect(h.service.create(7, { ...baseInput, method: 'DELETE' })).rejects.toThrow(/GET\/POST/);
    await expect(h.service.create(7, { ...baseInput, method: 'POST', body: null })).rejects.toThrow(/请求体/);
    await expect(h.service.create(7, { ...baseInput, name: '' })).rejects.toThrow(/名称/);
  });

  it('resets the baseline when a compare-affecting field changes', async () => {
    const h = harness({ watcher: watcher({ lastValueHash: 'abc', lastChangedAt: '2026-10-11 10:00:00' }) });
    await h.service.update(7, 1, { url: 'https://example.com/api2' });
    const row = h.watchers.get(1)!;
    expect(row.lastValueHash).toBeNull();
    expect(row.lastChangedAt).toBeNull();
  });

  it('keeps the baseline when only cosmetic fields change', async () => {
    const h = harness({ watcher: watcher({ lastValueHash: 'abc', lastChangedAt: '2026-10-11 10:00:00' }) });
    await h.service.update(7, 1, { name: 'renamed', promptTemplate: 'other {diff}' });
    const row = h.watchers.get(1)!;
    expect(row.lastValueHash).toBe('abc');
    expect(row.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('resets failures and baseline when re-enabling a disabled watcher', async () => {
    const h = harness({ watcher: watcher({ status: 'DISABLED', consecutiveFailures: 5, lastValueHash: 'abc' }) });
    await h.service.setStatus(7, 1, 'ACTIVE');
    const row = h.watchers.get(1)!;
    expect(row.status).toBe('ACTIVE');
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastValueHash).toBeNull();
  });

  it('rejects status values other than ACTIVE/PAUSED', async () => {
    const h = harness();
    await expect(h.service.setStatus(7, 1, 'DISABLED' as never)).rejects.toThrow(BusinessException);
  });

  it('rejects access to another user watcher', async () => {
    const h = harness();
    await expect(h.service.get(999, 1)).rejects.toThrow(BusinessException);
    await expect(h.service.update(999, 1, { name: 'x' })).rejects.toThrow(BusinessException);
    await expect(h.service.remove(999, 1)).rejects.toThrow(BusinessException);
  });

  it('deletes the watcher and cascades its checks', async () => {
    const h = harness();
    await h.service.remove(7, 1);
    expect(h.watchers.has(1)).toBe(false);
    expect(h.checks.filter((c) => c.watcherId === 1)).toHaveLength(0);
  });

  it('reports body length and hasBody instead of body content', async () => {
    const h = harness();
    const view = await h.service.create(7, { ...baseInput, method: 'POST', body: '{"secret":"x"}' });
    expect(view.hasBody).toBe(true);
    expect(view.bodyLength).toBe(14);
    expect(JSON.stringify(view)).not.toContain('secret');
  });
});

describe('WatcherService.runCheck', () => {
  it('establishes the baseline on the first poll without triggering', async () => {
    const h = harness();
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.watchers.get(1)!.lastValueHash).toBeTruthy();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.changed).toBe(0);
    // 首轮建基线：新值非空、旧值为 NULL（无对照），watcher 行「上次变化」仍为 NULL
    expect(h.checks[0]!.newValueSnippet).toBe('body');
    expect(h.checks[0]!.oldValueSnippet).toBeNull();
    expect(h.watchers.get(1)!.lastChangeOldSnippet).toBeNull();
    expect(h.watchers.get(1)!.lastChangeNewSnippet).toBeNull();
  });

  it('writes the check snippets from the runCheck start snapshot (see §7.2)', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', lastValueSnippet: 'old-body' }),
      probe: () => probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') }),
    });
    // 探针在途期间用户编辑判定字段：触发前 fresh 复读到的是改后值（EDITED-BODY），
    // 但旧值必须仍是 runCheck 开头快照的 old-body——不能改用 473 行复读的 fresh。
    const repo = (h.service as unknown as { deps: { watcherRepo: { findById: ReturnType<typeof vi.fn> } } }).deps.watcherRepo;
    repo.findById = vi.fn()
      .mockResolvedValueOnce(watcher({ lastValueHash: 'different', lastValueSnippet: 'old-body' }))
      .mockResolvedValue(watcher({ lastValueHash: 'different', lastValueSnippet: 'EDITED-BODY' }));
    await h.service.runCheck(1);
    expect(h.checks[0]!.changed).toBe(1);
    expect(h.checks[0]!.oldValueSnippet).toBe('old-body');
    expect(h.checks[0]!.newValueSnippet).toBe('new-body');
    // watcher 行「上次变化」新旧值对同写
    expect(h.watchers.get(1)!.lastChangeOldSnippet).toBe('old-body');
    expect(h.watchers.get(1)!.lastChangeNewSnippet).toBe('new-body');
  });

  it('truncates stored snippets to the buildDiff 500-char contract', async () => {
    const longOld = 'o'.repeat(600);
    const longNew = 'n'.repeat(600);
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', lastValueSnippet: longOld }),
      probe: () => probeResult({ body: longNew, bodyBytes: Buffer.from(longNew, 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.checks[0]!.oldValueSnippet).toBe(`${longOld.slice(0, 500)}…（已截断）`);
    expect(h.checks[0]!.newValueSnippet).toBe(`${longNew.slice(0, 500)}…（已截断）`);
    expect(h.watchers.get(1)!.lastChangeNewSnippet).toBe(`${longNew.slice(0, 500)}…（已截断）`);
  });

  it('does not trigger when the value is unchanged', async () => {
    const h = harness({ watcher: watcher({ lastValueHash: sha256('body'), lastValueSnippet: 'body' }) });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.checks[0]!.changed).toBe(0);
    expect(h.watchers.get(1)!.consecutiveFailures).toBe(0);
  });

  it('triggers with source SIGNAL and renders the prompt when the value changes', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', lastValueSnippet: 'old-body' }),
      probe: () => probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    const arg = h.openRun.run.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.source).toBe('SIGNAL');
    expect(arg.userId).toBe(7);
    expect(arg.agentId).toBe(3);
    expect(arg.sessionId).toBeNull();
    expect(String(arg.message)).toContain('new-body');
    expect(String(arg.message)).toContain('old-body');
    expect(h.checks[0]!.changed).toBe(1);
    expect(h.checks[0]!.triggeredSessionId).toBe(42);
    expect(h.watchers.get(1)!.lastValueHash)
      .toBe(sha256('new-body'));
    expect(h.watchers.get(1)!.lastChangedAt).toBeTruthy();
  });

  it('does nothing when the row is gone or not ACTIVE', async () => {
    const h = harness();
    h.watchers.delete(1);
    await h.service.runCheck(1);
    expect(h.probeExecute).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(0);

    const paused = harness({ watcher: watcher({ status: 'PAUSED' }) });
    await paused.service.runCheck(1);
    expect(paused.probeExecute).not.toHaveBeenCalled();
  });

  it('records a failure and backs off when the probe fails', async () => {
    const h = harness({ probe: () => probeResult({ ok: false, httpStatus: null, body: null, bodyBytes: null, error: '连接失败: ECONNREFUSED' }) });
    await h.service.runCheck(1);
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    // 第一次失败退避 = interval * 2^0 = 15 分钟
    expect(h.recordFailure.mock.calls[0]![1]).toBe(15);
    expect(h.checks.some((c) => c.error?.includes('ECONNREFUSED'))).toBe(true);
  });

  it('uses exponential backoff capped at 32x', async () => {
    const h = harness({
      watcher: watcher({ consecutiveFailures: 3 }),
      probe: () => probeResult({ ok: false, error: 'timeout' }),
    });
    await h.service.runCheck(1);
    expect(h.recordFailure.mock.calls[0]![1]).toBe(15 * 8);

    const capped = harness({
      watcher: watcher({ consecutiveFailures: 10 }),
      probe: () => probeResult({ ok: false, error: 'timeout' }),
    });
    await capped.service.runCheck(1);
    expect(capped.recordFailure.mock.calls[0]![1]).toBe(15 * 32);
  });

  it('notifies once when the failure threshold disables the watcher', async () => {
    const h = harness({
      watcher: watcher({ consecutiveFailures: WATCHER_DISABLE_AFTER_FAILURES - 1 }),
      probe: () => probeResult({ ok: false, error: 'timeout' }),
    });
    await h.service.runCheck(1);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({ watcherId: 1, failures: WATCHER_DISABLE_AFTER_FAILURES });
  });

  it('does not notify before the threshold is reached', async () => {
    const h = harness({
      watcher: watcher({ consecutiveFailures: WATCHER_DISABLE_AFTER_FAILURES - 2 }),
      probe: () => probeResult({ ok: false, error: 'timeout' }),
    });
    await h.service.runCheck(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does not disable a PAUSED watcher on failure', async () => {
    const h = harness({
      watcher: watcher({ status: 'PAUSED', consecutiveFailures: WATCHER_DISABLE_AFTER_FAILURES }),
      probe: () => probeResult({ ok: false, error: 'timeout' }),
    });
    await h.service.runCheck(1);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('records a failure when JSON parsing fails', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v' }),
      probe: () => probeResult({ body: 'not-json', bodyBytes: Buffer.from('not-json', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.checks.some((c) => c.error?.includes('JSON'))).toBe(true);
  });

  it('records a failure when the json path cannot be extracted', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'missing.field' }),
      probe: () => probeResult({ body: '{"v":1}', bodyBytes: Buffer.from('{"v":1}', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
  });

  it('counts a budget BLOCK toward consecutive failures', async () => {
    const h = harness({ watcher: watcher({ lastValueHash: 'different' }) });
    h.openRun.run.mockRejectedValue(new BusinessException(ErrorCode.BUDGET_EXCEEDED, '超限'));
    await h.service.runCheck(1);
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.checks[0]!.triggeredSessionId).toBeNull();
  });

  // 回归：触发失败曾只调 recordFailure 而不传 checkId，另起一行 check——
  // 同一次轮询落「changed=1,error=null」与「changed=0,error=预算」两行自相矛盾的记录。
  // 且基线 hash 不推进，目标值不变时下一轮再次判为「变化」并重新发起 Agent 运行。
  it('reuses the check row and advances the baseline when the trigger fails', async () => {
    const h = harness({
      watcher: watcher({
        lastValueHash: 'oldhash',
        lastValueSnippet: 'old-body',
        lastChangeOldSnippet: 'prev-old',
        lastChangeNewSnippet: 'prev-new',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
      probe: () => probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') }),
    });
    h.openRun.run.mockRejectedValue(new Error('budget blocked'));
    await h.service.runCheck(1);

    // 只落一行：复用 markChanged 写过的那行，把失败原因补在同一行上
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.changed).toBe(1);
    expect(h.checks[0]!.error).toContain('budget blocked');
    expect(h.checks[0]!.triggeredSessionId).toBeNull();
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    // 只落一行即证明复用了已 markChanged 的那行；若未传 checkId，recordFailure 内部会另插一行
    // （harness 的 recordFailure mock 只收 3 参，故以行数作为复用的判据）
    // 本轮新旧值留在 check 行，详情列附在错误下面
    expect(h.checks[0]!.oldValueSnippet).toBe('old-body');
    expect(h.checks[0]!.newValueSnippet).toBe('new-body');

    // 基线推进到本次读到的值：同值再次轮询不再判为「变化」
    expect(h.watchers.get(1)!.lastValueHash).toBe(sha256('new-body'));
    // 列表卡「上次变化」仍是上一次成功触发：时间与内容都不因这次失败改写
    expect(h.watchers.get(1)!.lastChangedAt).toBe('2026-10-11 10:00:00');
    expect(h.watchers.get(1)!.lastChangeOldSnippet).toBe('prev-old');
    expect(h.watchers.get(1)!.lastChangeNewSnippet).toBe('prev-new');

    await h.service.runCheck(1);
    // 同值 → 不再触发，也不新增 check 行
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(h.checks).toHaveLength(2);
    expect(h.checks[1]!.changed).toBe(0);
  });

  it('keeps triggering but flags a warning past the hourly cap', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different' }),
      probe: () => probeResult({ body: 'changed', bodyBytes: Buffer.from('changed', 'utf8') }),
    });
    // 预置已触发 WATCHER_MAX_TRIGGERS_PER_HOUR 次（facke checkRepo 的计数按 triggered_session_id 计）
    for (let i = 0; i < WATCHER_MAX_TRIGGERS_PER_HOUR; i += 1) {
      h.checks.push({ id: 500 + i, watcherId: 1, checkedAt: null, httpStatus: 200, valueHash: 'h', changed: 1, triggeredSessionId: 900 + i, error: null, durationMs: 1, warning: null });
    }
    await h.service.runCheck(1);
    // 决策 7：照常触发，仅打 warning，不计失败
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(h.recordFailure).not.toHaveBeenCalled();
    const last = h.checks.find((c) => c.watcherId === 1 && c.triggeredSessionId === 42)!;
    expect(last.warning).toBe('TRIGGER_RATE_LIMITED');
  });

  it('clears failures on a successful poll', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', consecutiveFailures: 3 }),
      probe: () => probeResult({ body: 'x', bodyBytes: Buffer.from('x', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.watchers.get(1)!.consecutiveFailures).toBe(0);
  });

  it('clears a single prior failure on the next success（BUG-N：不能卡在 1）', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', consecutiveFailures: 1 }),
      probe: () => probeResult({ body: 'x', bodyBytes: Buffer.from('x', 'utf8') }),
    });
    await h.service.runCheck(1);
    // service 传本次读到的快照值 1，fake repo 的 IF(库内=快照, 0, 库内) 命中 → 归零
    expect(h.watchers.get(1)!.consecutiveFailures).toBe(0);
  });

  it('keeps a concurrently incremented failure count（探针在途期间并发失败）', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: 'different', consecutiveFailures: 0 }),
      probe: async () => {
        // 探针在途期间并发 recordFailure 把库里累加到 3
        h.watchers.get(1)!.consecutiveFailures = 3;
        return probeResult({ body: 'x', bodyBytes: Buffer.from('x', 'utf8') });
      },
    });
    await h.service.runCheck(1);
    // 快照是 0，库里已是 3 → 条件不清零，保留 3
    expect(h.watchers.get(1)!.consecutiveFailures).toBe(3);
  });

  it('STATUS_CODE mode triggers on a status change', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'STATUS_CODE', lastValueHash: sha256('200'), lastValueSnippet: '200' }),
      probe: () => probeResult({ httpStatus: 503 }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(String(h.openRun.run.mock.calls[0]![0].message)).toContain('200 → 503');
  });

  it('STATUS_CODE mode does not trigger when the status is unchanged', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'STATUS_CODE', lastValueHash: sha256('200') }),
      probe: () => probeResult({ httpStatus: 200 }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
  });

  it('JSON_FIELD mode ignores noise outside the extracted field', async () => {
    // 提取到的是字符串 "1"，规范化文本就是 1（不再套引号）
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v', lastValueHash: sha256('1'), lastValueSnippet: '1' }),
      probe: () => probeResult({ body: '{"v":"1","noise":"changed"}', bodyBytes: Buffer.from('{"v":"1","noise":"changed"}', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
  });

  it('JSON_FIELD mode triggers when the extracted field changes', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v', lastValueHash: sha256('1'), lastValueSnippet: '1' }),
      probe: () => probeResult({ body: '{"v":"2"}', bodyBytes: Buffer.from('{"v":"2"}', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    expect(String(h.openRun.run.mock.calls[0]![0].message)).toContain('旧值：1');
    expect(String(h.openRun.run.mock.calls[0]![0].message)).toContain('新值：2');
  });

  it('does not throw when the probe executor rejects', async () => {
    const h = harness();
    h.probeExecute.mockRejectedValue(new Error('boom'));
    await expect(h.service.runCheck(1)).resolves.toBeUndefined();
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
  });
});

describe('WatcherService.test', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns a preview without triggering or persisting', async () => {
    const h = harness({ probe: () => probeResult({ body: 'sample-body' }) });
    const result = await h.service.test(7, 1);
    expect(result.httpStatus).toBe(200);
    expect(result.parseOk).toBe(true);
    expect(result.valueHash).toBeTruthy();
    expect(result.sample).toBe('sample-body');
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(0);
  });

  it('reports parseOk=false for a bad json path', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v' }),
      probe: () => probeResult({ body: 'nope' }),
    });
    const result = await h.service.test(7, 1);
    expect(result.parseOk).toBe(false);
    expect(result.valueHash).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('reports the probe error when the probe fails', async () => {
    const h = harness({ probe: () => probeResult({ ok: false, error: '连接失败: ECONNREFUSED' }) });
    const result = await h.service.test(7, 1);
    expect(result.parseOk).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

describe('WatcherService.update 敏感字段保留语义（BUG-2/3/4/SUG-3 回归）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('keeps stored sensitive headers and body when they are not sent', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({
        method: 'POST',
        headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })),
        body: cipher.encrypt('{"k":1}'),
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    // 只改名称：headers / body / jsonPath 都未下发
    await h.service.update(7, 1, { name: 'renamed' });
    const stored = h.watchers.get(1)!;
    expect(stored.name).toBe('renamed');
    expect(JSON.parse(cipher.decrypt(stored.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
    expect(cipher.decrypt(stored.body!)).toBe('{"k":1}');
    // 未触碰判定字段：基线必须保留
    expect(stored.lastValueHash).toBe('abc');
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('resets the baseline (hash + snippet + changedAt) when the url changes', async () => {
    const h = harness({
      watcher: watcher({
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD-SNIPPET',
        lastChangeOldSnippet: 'PREV-OLD',
        lastChangeNewSnippet: 'PREV-NEW',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    await h.service.update(7, 1, { url: 'https://example.com/api2' });
    const stored = h.watchers.get(1)!;
    expect(stored.url).toBe('https://example.com/api2');
    expect(stored.lastValueHash).toBeNull();
    expect(stored.lastValueSnippet).toBeNull();
    expect(stored.lastChangedAt).toBeNull();
    // 基线重置同时清空「上次变化」新旧对（§4.1 / §7.5）
    expect(stored.lastChangeOldSnippet).toBeNull();
    expect(stored.lastChangeNewSnippet).toBeNull();
  });

  it('setStatus DISABLED→ACTIVE clears the last-change snippet pair (§7.5)', async () => {
    const h = harness({
      watcher: watcher({
        status: 'DISABLED',
        consecutiveFailures: 5,
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangeOldSnippet: 'PREV-OLD',
        lastChangeNewSnippet: 'PREV-NEW',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    await h.service.setStatus(7, 1, 'ACTIVE');
    const stored = h.watchers.get(1)!;
    expect(stored.status).toBe('ACTIVE');
    expect(stored.consecutiveFailures).toBe(0);
    expect(stored.lastValueSnippet).toBeNull();
    expect(stored.lastChangeOldSnippet).toBeNull();
    expect(stored.lastChangeNewSnippet).toBeNull();
    expect(stored.lastChangedAt).toBeNull();
  });

  it('setStatus PAUSED→ACTIVE does NOT clear the snippet pair (§7.5)', async () => {
    const h = harness({
      watcher: watcher({
        status: 'PAUSED',
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangeOldSnippet: 'PREV-OLD',
        lastChangeNewSnippet: 'PREV-NEW',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    await h.service.setStatus(7, 1, 'ACTIVE');
    const stored = h.watchers.get(1)!;
    expect(stored.status).toBe('ACTIVE');
    // 暂停后再启用不重置基线，两句（lastValueSnippet / 上次变化）仍在
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangeOldSnippet).toBe('PREV-OLD');
    expect(stored.lastChangeNewSnippet).toBe('PREV-NEW');
  });

  it('replaces a masked header value with the stored one instead of storing the mask', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({
        headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })),
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    // 把回显打码值原样回传（非前端来源的调用）：掩码被替换成库内原值，
    // 与库里内容一致 → 不算「判定字段变化」，基线必须保留
    await h.service.update(7, 1, { headers: { Authorization: '******' } });
    const stored = h.watchers.get(1)!;
    expect(JSON.parse(cipher.decrypt(stored.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
    expect(stored.lastValueHash).toBe('abc');
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('masked value 按小写归一还原为库内原值（BUG-F）', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({ headersJson: cipher.encrypt(JSON.stringify({ authorization: 'Bearer SECRET' })) }),
    });
    // 库内小写键 + 入参大写键，HTTP 头大小写不敏感，必须能替换到
    await h.service.update(7, 1, { headers: { Authorization: '******' } });
    const stored = h.watchers.get(1)!;
    expect(JSON.parse(cipher.decrypt(stored.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
  });

  it('掩码回传（大小写不一致）不重置基线：与库内内容实质相同', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({
        headersJson: cipher.encrypt(JSON.stringify({ authorization: 'Bearer SECRET' })),
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    await h.service.update(7, 1, { headers: { Authorization: '******' } });
    const stored = h.watchers.get(1)!;
    expect(stored.lastValueHash).toBe('abc');
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('敏感键改名后仍回传掩码：报错而不是把 ****** 当凭据落库', async () => {
    // 前端会把留空的敏感行以 '******' 下发；库内没有同名键（用户改了键名）时，
    // 若回退成字面量落库，之后每次探针都会真的发出 `X-Api-Key: ******`。
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({ headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer SECRET' })) }),
    });
    await expect(h.service.update(7, 1, { headers: { 'X-Api-Key': '******' } }))
      .rejects.toThrow('请求头 X-Api-Key 需要填写新的值');
    // 落库值保持不变：仍是库内原值，没有写入 '******' 字面量
    expect(JSON.parse(cipher.decrypt(h.watchers.get(1)!.headersJson!))).toEqual({ Authorization: 'Bearer SECRET' });
  });

  it('请求头值真的变化时仍然重置基线（防止归一化过度放宽）', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({
        headersJson: cipher.encrypt(JSON.stringify({ Authorization: 'Bearer OLD' })),
        lastValueHash: 'abc',
      }),
    });
    await h.service.update(7, 1, { headers: { Authorization: 'Bearer NEW' } });
    expect(h.watchers.get(1)!.lastValueHash).toBeNull();
  });

  it('非 POST 方法（含小写 post 归一化后为 POST）body 语义正确', async () => {
    // 小写 post 归一化为 POST：必须仍按 POST 校验，不能误清 body
    const h = harness({
      watcher: watcher({ method: 'POST', body: null, lastValueHash: 'abc' }),
    });
    await h.service.update(7, 1, { method: 'post', body: '{"q":"x"}' });
    const stored = h.watchers.get(1)!;
    expect(stored.method).toBe('POST');
    expect(stored.body).toBeTruthy();
  });

  it('多请求头且键序不同 + 全掩码回传 → 不重置基线（BUG-L）', async () => {
    const cipher = makeCipher();
    const h = harness({
      watcher: watcher({
        headersJson: cipher.encrypt(JSON.stringify({ Accept: 'application/json', Authorization: 'Bearer SECRET' })),
        lastValueHash: 'abc',
        lastValueSnippet: 'OLD',
        lastChangedAt: '2026-10-11 10:00:00',
      }),
    });
    // 入参键序与库内相反，且两个敏感/普通键都以掩码或原值回传
    await h.service.update(7, 1, {
      headers: { Authorization: '******', Accept: 'application/json' },
    });
    const stored = h.watchers.get(1)!;
    expect(stored.lastValueHash).toBe('abc');
    expect(stored.lastValueSnippet).toBe('OLD');
    expect(stored.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('keeps a JSON_FIELD watcher editable when jsonPath is not sent', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'data.price', lastValueHash: 'abc' }),
    });
    await h.service.update(7, 1, { name: 'renamed' });
    const stored = h.watchers.get(1)!;
    expect(stored.jsonPath).toBe('data.price');
    expect(stored.lastValueHash).toBe('abc');
  });

  it('does not reset the baseline when headers change from {} to null (empty set)', async () => {
    const h = harness({ watcher: watcher({ lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { headers: null });
    expect(h.watchers.get(1)!.lastValueHash).toBe('abc');
  });
});

describe('WatcherService.runCheck 触发前状态复读（BUG-7 回归）', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('does not trigger when the watcher is paused while the probe is in flight', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: sha256('old'), lastValueSnippet: 'old' }),
      probe: async () => {
        // 探针在途期间用户点暂停
        h.watchers.get(1)!.status = 'PAUSED';
        return probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') });
      },
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
    // check 行仍记录了这次变化（可观测性不丢）
    expect(h.checks.some((c) => c.changed === 1)).toBe(true);
  });

  it('does not trigger when the row is deleted while the probe is in flight', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: sha256('old'), lastValueSnippet: 'old' }),
      probe: async () => {
        h.watchers.delete(1);
        return probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') });
      },
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
  });

  it('still triggers when the watcher stays ACTIVE across the probe', async () => {
    const h = harness({
      watcher: watcher({ lastValueHash: sha256('old'), lastValueSnippet: 'old' }),
      probe: () => probeResult({ body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
  });
});

// ── review 探针：2026-10-12 逻辑 BUG 验证（非产品用例，修复后应转正或删除） ──

describe('JSON 取值失败只能落一行 check', () => {
  it('JSON 解析失败：一次轮询只插一行 check（当前实现为两行）', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v', lastValueHash: sha256('1'), lastValueSnippet: '1' }),
      probe: () => probeResult({ body: 'not-json', bodyBytes: Buffer.from('not-json', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.error).toContain('JSON');
    expect(h.checks[0]!.valueHash).toBeNull();
    expect(h.checks[0]!.httpStatus).toBe(200);
    expect((await h.service.listChecks(7, 1, 20)).rows).toHaveLength(1);
  });

  it('jsonPath 取不到值：一次轮询只插一行 check', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'missing.field', lastValueHash: sha256('1') }),
      probe: () => probeResult({ body: '{"v":1}', bodyBytes: Buffer.from('{"v":1}', 'utf8') }),
    });
    await h.service.runCheck(1);
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.error).toContain('路径段 missing 不存在');
  });

  it('对照组：探针本身失败仍只落一行 check', async () => {
    const h = harness({
      watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'v' }),
      probe: () => probeResult({ ok: false, httpStatus: 500, body: '', bodyBytes: Buffer.from('', 'utf8'), error: 'boom' }),
    });
    await h.service.runCheck(1);
    expect(h.checks).toHaveLength(1);
  });
});

describe('归一化后无变化的编辑不得清基线', () => {
  it('小写 method 回传不重置基线', async () => {
    const h = harness({
      watcher: watcher({ method: 'GET', lastValueHash: 'abc', lastValueSnippet: 'OLD', lastChangedAt: '2026-10-11 10:00:00' }),
    });
    await h.service.update(7, 1, { method: 'get' });
    const row = h.watchers.get(1)!;
    expect(row.method).toBe('GET');
    expect(row.lastValueHash).toBe('abc');
    expect(row.lastValueSnippet).toBe('OLD');
    expect(row.lastChangedAt).toBe('2026-10-11 10:00:00');
  });

  it('小写 compareMode 回传不重置基线', async () => {
    const h = harness({ watcher: watcher({ compareMode: 'HASH', lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { compareMode: 'hash' });
    expect(h.watchers.get(1)!.lastValueHash).toBe('abc');
  });

  it('jsonPath 仅首尾空白差异不重置基线', async () => {
    const h = harness({ watcher: watcher({ compareMode: 'JSON_FIELD', jsonPath: 'data.price', lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { jsonPath: ' data.price ' });
    expect(h.watchers.get(1)!.jsonPath).toBe('data.price');
    expect(h.watchers.get(1)!.lastValueHash).toBe('abc');
  });

  it('URL 仅主机大小写差异不重置基线', async () => {
    const h = harness({ watcher: watcher({ url: 'https://example.com/api', lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { url: 'https://Example.com/api' });
    expect(h.watchers.get(1)!.url).toBe('https://example.com/api');
    expect(h.watchers.get(1)!.lastValueHash).toBe('abc');
  });

  it('对照组：判定字段真实变化仍重置基线', async () => {
    const h = harness({ watcher: watcher({ url: 'https://example.com/api', lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { url: 'https://example.org/api' });
    expect(h.watchers.get(1)!.lastValueHash).toBeNull();
  });
});

describe('WatcherService 触发方式（D8 模型 B：复用自己的会话）', () => {
  const changed = { lastValueHash: 'different', lastValueSnippet: 'old' } as const;
  const newBody = { body: 'new-body', bodyBytes: Buffer.from('new-body', 'utf8') } as const;

  it('create 默认 NEW_SESSION，指针恒为空', async () => {
    const h = harness();
    const view = await h.service.create(7, baseInput);
    expect(view.triggerMode).toBe('NEW_SESSION');
    expect(view.reuseSessionId).toBeNull();
    expect(h.watchers.get(view.id)!.triggerMode).toBe('NEW_SESSION');
    expect(h.watchers.get(view.id)!.reuseSessionId).toBeNull();
  });

  it('rejects an unknown trigger mode and normalizes case', async () => {
    const h = harness();
    await expect(h.service.create(7, { ...baseInput, triggerMode: 'NOPE' })).rejects.toThrow(/触发方式/);
    const view = await h.service.create(7, { ...baseInput, name: 'w2', triggerMode: 'reuse_session' });
    expect(view.triggerMode).toBe('REUSE_SESSION');
  });

  it('NEW_SESSION 全程不收 sessionId，也不做指针预检', async () => {
    const h = harness({ watcher: watcher({ ...changed }), probe: () => probeResult(newBody) });
    await h.service.runCheck(1);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBeNull();
    expect(h.getSession).not.toHaveBeenCalled();
    expect(h.watchers.get(1)!.reuseSessionId).toBeNull();
    // 再造一次变化：确认第二次触发同样不带 sessionId
    h.watchers.get(1)!.lastValueHash = 'different3';
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(2);
    expect(h.openRun.run.mock.calls[1]![0].sessionId).toBeNull();
    expect(h.watchers.get(1)!.reuseSessionId).toBeNull();
  });

  it('REUSE_SESSION 首触不传 sessionId，成功后把新会话回写为指针', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', ...changed }), probe: () => probeResult(newBody) });
    await h.service.runCheck(1);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBeNull();
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
    // 同一轮只回写一次
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });

  it('REUSE_SESSION 次触传指针 sessionId（复用同一会话）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }), probe: () => probeResult(newBody) });
    await h.service.runCheck(1);
    expect(h.getSession).toHaveBeenCalledWith(42);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBe(42);
    // 已有指针时不重复回写
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });

  it('REUSE_SESSION 轮询记录 triggeredSessionId 相同（复用同一会话）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }), probe: () => probeResult(newBody) });
    await h.service.runCheck(1);
    // 造第二次变化：直接改库内 hash 快照（update 不提供该入参）
    h.watchers.get(1)!.lastValueHash = 'different2';
    await h.service.runCheck(1);
    const triggered = h.checks.filter((c) => c.triggeredSessionId != null);
    expect(triggered.length).toBeGreaterThanOrEqual(1);
    expect(new Set(triggered.map((c) => c.triggeredSessionId))).toEqual(new Set([42]));
  });

  const invalidPointerCases: Array<[string, WatcherSessionLookup[]]> = [
    ['会话已删（getSession 返回 null）', []],
    ['会话非本人', [{ id: 42, userId: 8, sessionType: null, executionMode: 'CLOUD', agentId: 3 }]],
    ['会话属于其他 Agent', [{ id: 42, userId: 7, sessionType: null, executionMode: 'CLOUD', agentId: 99 }]],
    ['会话是 SUBAGENT', [{ id: 42, userId: 7, sessionType: 'SUBAGENT', executionMode: 'CLOUD', agentId: 3 }]],
    ['会话是 SIDE_TASK', [{ id: 42, userId: 7, sessionType: 'SIDE_TASK', executionMode: 'CLOUD', agentId: 3 }]],
    ['会话是 LOCAL', [{ id: 42, userId: 7, sessionType: null, executionMode: 'LOCAL', agentId: 3 }]],
    ['会话已归档', [{ id: 42, userId: 7, sessionType: null, executionMode: 'CLOUD', agentId: 3, status: 'ARCHIVED' }]],
  ];

  it.each(invalidPointerCases)('指针失效（%s）时清指针走新建且不计连败', async (_label, sessions) => {
    const h = harness({
      watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }),
      sessions,
      probe: () => probeResult(newBody),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBeNull();
    // 自建后回写指针（openRun 返回的 sessionId=42）
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.checks[0]!.triggeredSessionId).toBe(42);
  });

  /**
   * 回归（code review 01 的 Bug 1）：SessionService.getSession 在行不存在（含软删）时
   * 抛 BusinessException(SESSION_NOT_FOUND) 而不是返回 null，装配层
   * app-openapi-services.ts 直接把它传给 deps.getSession。早年 isReusableSession 只按
   * null 分支判失效，异常被 runCheck 的 try 吞成「触发失败」：用户删掉复用的会话后
   * ① openRun 根本不被调用，变化被静默吞掉；② 白烧连败，5 次后自动停用并通知；
   * ③ 清指针代码在异常点之后永不可达，指针一直是已删 id，每轮重复。这里按生产
   * wiring 的真实语义（抛异常）钉死正确行为。
   */
  it('生产 wiring 回归：getSession 抛 SESSION_NOT_FOUND 判指针失效——清指针、照常触发、不计连败', async () => {
    const h = harness({
      watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }),
      getSession: async () => { throw new BusinessException(ErrorCode.SESSION_NOT_FOUND); },
      probe: () => probeResult(newBody),
    });
    await h.service.runCheck(1);
    expect(h.getSession).toHaveBeenCalledWith(42);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBeNull();
    // 自建的新会话回写成指针（openRun 返回 42）
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.checks[0]!.error).toBeNull();
    expect(h.checks[0]!.changed).toBe(1);
    expect(h.checks[0]!.triggeredSessionId).toBe(42);
  });

  it('生产 wiring 回归：失效重建后的下一次变化复用新会话（不再每轮新建）', async () => {
    // 第一轮指针 42 已删（抛 SESSION_NOT_FOUND）→ 失效重建并回写；
    // 第二轮指针已是回写后的会话，预检放行 → 传 sessionId 复用。
    let pointerDeleted = true;
    const h = harness({
      watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }),
      getSession: async (id) => {
        if (id === 42 && pointerDeleted) {
          pointerDeleted = false;
          throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        }
        return { id, userId: 7, sessionType: null, executionMode: 'CLOUD', agentId: 3 };
      },
      probe: () => probeResult(newBody),
    });
    await h.service.runCheck(1);
    h.watchers.get(1)!.lastValueHash = 'different-2';
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(2);
    expect(h.openRun.run.mock.calls[0]![0].sessionId).toBeNull();
    expect(h.openRun.run.mock.calls[1]![0].sessionId).toBe(42);
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it('getSession 抛非「会话不存在」异常时仍记触发失败，不误判指针失效', async () => {
    // 库瞬断等未知异常不能当成「指针失效」：那会静默丢掉原会话另起一个。
    const h = harness({
      watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, ...changed }),
      getSession: async () => { throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'db down'); },
      probe: () => probeResult(newBody),
    });
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
    expect(h.checks[0]!.triggeredSessionId).toBeNull();
    // 没有证据表明指针失效：保持原值，等下次预检
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });

  it('切出复用模式（REUSE→NEW）即清指针', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { triggerMode: 'NEW_SESSION' });
    expect(h.watchers.get(1)!.triggerMode).toBe('NEW_SESSION');
    expect(h.watchers.get(1)!.reuseSessionId).toBeNull();
  });

  it('「切到新建再切回」往返即手动重置指针（NEW→REUSE 不复活旧指针）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { triggerMode: 'NEW_SESSION' });
    await h.service.update(7, 1, { triggerMode: 'REUSE_SESSION' });
    expect(h.watchers.get(1)!.triggerMode).toBe('REUSE_SESSION');
    expect(h.watchers.get(1)!.reuseSessionId).toBeNull();
  });

  it('改 agentId 清指针（旧指针指向的会话属于旧 Agent，openRun 会拒绝）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { agentId: 9 });
    expect(h.watchers.get(1)!.agentId).toBe(9);
    expect(h.watchers.get(1)!.reuseSessionId).toBeNull();
  });

  it('复用模式下改无关字段不清指针（回归）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { name: 'renamed' });
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });

  it('复用模式编辑时未下发 triggerMode 则沿用原值（回归）', async () => {
    const h = harness({ watcher: watcher({ triggerMode: 'REUSE_SESSION', reuseSessionId: 42, lastValueHash: 'abc' }) });
    await h.service.update(7, 1, { promptTemplate: 'other {diff}' });
    expect(h.watchers.get(1)!.triggerMode).toBe('REUSE_SESSION');
    expect(h.watchers.get(1)!.reuseSessionId).toBe(42);
  });
});

describe('WatcherService.create 复制继承（copyFrom）', () => {
  const cipher = makeCipher();
  const sourceHeaders = { Authorization: 'Bearer SECRET', Accept: 'application/json' };

  function sourceWatcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
    return watcher({
      id: 50,
      name: 'src',
      method: 'POST',
      headersJson: cipher.encrypt(JSON.stringify(sourceHeaders)),
      body: cipher.encrypt('{"k":"v"}'),
      triggerMode: 'REUSE_SESSION',
      reuseSessionId: 42,
      ...overrides,
    });
  }

  it('掩码敏感头 + 未下发 body → 从源行解密继承，基线为空、ACTIVE、指针不继承', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, {
      ...baseInput,
      body: undefined, // 键未下发 = 沿用源行（前端复制态不预填 body 明文）
      name: 'src 副本',
      method: 'POST',
      headers: { Authorization: '******', Accept: 'application/json' },
      copyFrom: 50,
    });
    const stored = h.watchers.get(view.id)!;
    // 密文解密后与源行一致（不是掩码、也不是新值）
    expect(JSON.parse(cipher.decrypt(stored.headersJson!))).toEqual(sourceHeaders);
    expect(cipher.decrypt(stored.body!)).toBe('{"k":"v"}');
    // D7：副本 ACTIVE、基线置空；D8：指针不继承（每个哨兵复用自己的会话）
    expect(stored.status).toBe('ACTIVE');
    expect(stored.lastValueHash).toBeNull();
    expect(stored.triggerMode).toBe('NEW_SESSION');
    expect(stored.reuseSessionId).toBeNull();
  });

  it('改名后的掩码键报错，不把 ****** 当凭据落库', async () => {
    const h = harness({ watcher: sourceWatcher() });
    await expect(h.service.create(7, {
      ...baseInput,
      method: 'POST',
      headers: { 'X-Api-Key': '******' },
      copyFrom: 50,
    })).rejects.toThrow('请求头 X-Api-Key 需要填写新的值');
    // 源行未被污染
    expect(JSON.parse(cipher.decrypt(h.watchers.get(50)!.headersJson!))).toEqual(sourceHeaders);
  });

  it('body 显式下发新值时覆盖继承值', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, {
      ...baseInput,
      method: 'POST',
      headers: { Authorization: 'Bearer SECRET', Accept: 'application/json' },
      body: '{"k":"new"}',
      copyFrom: 50,
    });
    expect(cipher.decrypt(h.watchers.get(view.id)!.body!)).toBe('{"k":"new"}');
  });

  it('删光请求头行 = 无请求头（归一化为 null）', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, {
      ...baseInput,
      method: 'POST',
      headers: {},
      body: '{"k":"v"}',
      copyFrom: 50,
    });
    expect(h.watchers.get(view.id)!.headersJson).toBeNull();
  });

  it('源行也无 body 时继承 null，由 POST 必填校验拦住', async () => {
    const h = harness({ watcher: sourceWatcher({ body: null }) });
    await expect(h.service.create(7, {
      ...baseInput,
      method: 'POST',
      headers: { Authorization: 'Bearer SECRET' },
      copyFrom: 50,
    })).rejects.toThrow(/请求体/);
  });

  it('GET 复制不继承 body（body 只对 POST 有意义）', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, {
      ...baseInput,
      method: 'GET',
      headers: { Authorization: 'Bearer SECRET', Accept: 'application/json' },
      copyFrom: 50,
    });
    expect(h.watchers.get(view.id)!.body).toBeNull();
  });

  it('copyFrom 非本人 / 不存在均拒绝', async () => {
    const h = harness({ watcher: sourceWatcher() });
    await expect(h.service.create(999, { ...baseInput, copyFrom: 50 })).rejects.toThrow(/哨兵不存在/);
    await expect(h.service.create(7, { ...baseInput, copyFrom: 777 })).rejects.toThrow(/哨兵不存在/);
    // 拒绝时不得留下任何新行
    expect(h.watchers.size).toBe(1);
  });

  it('create 无 copyFrom 时行为零变化（回归：不下发 headers/body 即 null）', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, { ...baseInput, name: 'plain' });
    const stored = h.watchers.get(view.id)!;
    expect(stored.headersJson).toBeNull();
    expect(stored.body).toBeNull();
    expect(stored.triggerMode).toBe('NEW_SESSION');
  });

  it('复制态其余字段随请求体原样下发（含 triggerMode）', async () => {
    const h = harness({ watcher: sourceWatcher() });
    const view = await h.service.create(7, {
      ...baseInput,
      body: undefined,
      name: 'src 副本',
      method: 'POST',
      intervalMinutes: 30,
      triggerMode: 'REUSE_SESSION',
      headers: { Authorization: 'Bearer SECRET', Accept: 'application/json' },
      copyFrom: 50,
    });
    const stored = h.watchers.get(view.id)!;
    expect(stored.intervalMinutes).toBe(30);
    expect(stored.triggerMode).toBe('REUSE_SESSION');
    expect(stored.reuseSessionId).toBeNull();
  });
});

describe('WatcherService 管理后台只读', () => {
  it('getForAdmin 跨用户返回脱敏详情 + userId', async () => {
    const h = harness();
    const created = await h.service.create(7, {
      ...baseInput,
      headers: { Authorization: 'Bearer t', Accept: 'application/json' },
    });
    const view = await h.service.getForAdmin(created.id);
    expect(view.userId).toBe(7);
    expect(view.headers.Authorization).toBe('******');
    expect(view.headers.Accept).toBe('application/json');
    expect(view.hasBody).toBe(false);
  });

  it('getForAdmin / listChecksForAdmin 对不存在的哨兵抛「哨兵不存在」', async () => {
    const h = harness();
    await expect(h.service.getForAdmin(999)).rejects.toThrow('哨兵不存在');
    await expect(h.service.listChecksForAdmin(999, 1, 20)).rejects.toThrow('哨兵不存在');
  });

  it('listChecksForAdmin 跨用户分页读取轮询记录', async () => {
    const h = harness();
    const created = await h.service.create(7, { ...baseInput, name: 'admin-read' });
    h.checks.push({
      id: 1,
      watcherId: created.id,
      checkedAt: '2026-11-02 10:00:00',
      httpStatus: 200,
      valueHash: 'hash',
      changed: 1,
      triggeredSessionId: 42,
      error: null,
      durationMs: 5,
      warning: null,
    });
    const page = await h.service.listChecksForAdmin(created.id, 1, 20);
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({ watcherId: created.id, triggeredSessionId: 42 });
  });
});

// ── 凭据占位符（2026-11-06 技术方案）────────────────────────────────────────

function placeholderHeadersWatcher(): SignalWatcher {
  const cipher = makeCipher();
  return watcher({
    headersJson: cipher.encrypt(JSON.stringify({
      Authorization: 'Bearer {{MAO_TOKEN}}',
      'X-Ecp': 'E {{ECP_TOKEN}}',
      Accept: 'application/json',
    })),
  });
}

describe('WatcherService 凭据占位符解析', () => {
  it('runCheck 在探针前把占位符替换为 resolver 现取的 token', async () => {
    const h = harness({
      watcher: placeholderHeadersWatcher(),
      credentialResolver: { resolve: vi.fn(async (_userId, kind) => (kind === 'MAO_TOKEN' ? 'tok-mao' : 'tok-ecp')) },
    });
    await h.service.runCheck(1);
    expect(h.probeExecute).toHaveBeenCalledTimes(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({
      Authorization: 'Bearer tok-mao',
      'X-Ecp': 'E tok-ecp',
      Accept: 'application/json',
    });
  });

  it('runCheck 解析失败只丢凭据头：探针照常执行、不计失败（D2/D3）', async () => {
    const h = harness({
      watcher: placeholderHeadersWatcher(),
      credentialResolver: { resolve: vi.fn(async () => null) },
    });
    await h.service.runCheck(1);
    expect(h.probeExecute).toHaveBeenCalledTimes(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({ Accept: 'application/json' });
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.error).toBeNull();
  });

  it('runCheck resolver 抛错不冒泡：与 null 同口径丢头，探针照常（§5.1.2）', async () => {
    const h = harness({
      watcher: placeholderHeadersWatcher(),
      credentialResolver: { resolve: vi.fn(async () => { throw new Error('db down'); }) },
    });
    await expect(h.service.runCheck(1)).resolves.toBeUndefined();
    expect(h.probeExecute).toHaveBeenCalledTimes(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({ Accept: 'application/json' });
    expect(h.recordFailure).not.toHaveBeenCalled();
  });

  it('runCheck 无 resolver：占位符字面量直发（D6 缺省路径，告警由 resolveProbeHeaders 打）', async () => {
    const h = harness({ watcher: placeholderHeadersWatcher() });
    await h.service.runCheck(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({
      Authorization: 'Bearer {{MAO_TOKEN}}',
      'X-Ecp': 'E {{ECP_TOKEN}}',
      Accept: 'application/json',
    });
  });

  it('test 与 runCheck 同口径：立即测试也解析占位符（§8.4）', async () => {
    const h = harness({
      watcher: placeholderHeadersWatcher(),
      credentialResolver: { resolve: vi.fn(async (_userId, kind) => (kind === 'MAO_TOKEN' ? 'tok-mao' : null)) },
    });
    const result = await h.service.test(7, 1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({
      Authorization: 'Bearer tok-mao',
      Accept: 'application/json',
    });
    expect(result.httpStatus).toBe(200);
  });

  it('create/update：纯占位符值原样落库（密文）、回显不打码、编辑回传不被当掩码（D5/§8.5）', async () => {
    const h = harness();
    const view = await h.service.create(7, { ...baseInput, headers: { Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' } });
    expect(view.headers).toEqual({ Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' });
    const stored = h.watchers.get(view.id)!;
    expect(stored.headersJson).not.toContain('{{MAO_TOKEN}}');
    expect(h.service.decryptHeadersForCompare(stored.headersJson)).toEqual({ Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' });

    // 编辑态原样回传（前端 headerPairsFromView 给的就是占位符原值）
    const updated = await h.service.update(7, view.id, { headers: { Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' } });
    expect(updated.headers).toEqual({ Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' });
    expect(h.service.decryptHeadersForCompare(h.watchers.get(view.id)!.headersJson))
      .toEqual({ Authorization: '{{MAO_TOKEN}}', 'X-Trace': '1' });
  });

  it('混合值 Bearer {{MAO_TOKEN}} 回显仍打码，掩码回传还原库内原值（D5）', async () => {
    const h = harness();
    const view = await h.service.create(7, { ...baseInput, headers: { Authorization: 'Bearer {{MAO_TOKEN}}' } });
    expect(view.headers.Authorization).toBe('******');
    const updated = await h.service.update(7, view.id, { headers: { Authorization: '******' } });
    expect(updated.headers.Authorization).toBe('******');
    expect(h.service.decryptHeadersForCompare(h.watchers.get(view.id)!.headersJson).Authorization)
      .toBe('Bearer {{MAO_TOKEN}}');
  });

  it('update 与 create 同一道 D4 闸：未识别占位符拒绝', async () => {
    const h = harness();
    const created = await h.service.create(7, baseInput);
    await expect(h.service.update(7, created.id, { headers: { 'X-A': '{{EVIL}}' } }))
      .rejects.toThrow(/不支持的占位符/);
  });

  it('复制继承：源哨兵的占位符头随掩码行继承到副本，副本执行时各自解析（§2 复制态回归）', async () => {
    const h = harness({
      credentialResolver: { resolve: vi.fn(async () => 'tok-copy') },
    });
    const source = await h.service.create(7, { ...baseInput, headers: { Authorization: 'Bearer {{MAO_TOKEN}}' } });
    // 复制预填：敏感头按回显（掩码行）回传
    const copy = await h.service.create(7, {
      ...baseInput, name: 'copy', headers: { Authorization: '******' }, copyFrom: source.id,
    });
    expect(copy.id).not.toBe(source.id);
    expect(h.service.decryptHeadersForCompare(h.watchers.get(copy.id)!.headersJson).Authorization)
      .toBe('Bearer {{MAO_TOKEN}}');
    // 副本执行时解析出的是副本自己那一次的 token
    await h.service.runCheck(copy.id);
    expect(h.probeExecute).toHaveBeenCalledTimes(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({ Authorization: 'Bearer tok-copy' });
  });
});

describe('存量 {{...}} 字面量头的兼容（review round 1）', () => {
  function legacyLiteralWatcher(): SignalWatcher {
    const cipher = makeCipher();
    return watcher({
      headersJson: cipher.encrypt(JSON.stringify({ 'X-Tpl': '{{EVIL}}', Accept: 'json' })),
    });
  }

  it('改名（未下发 headers）与未修改行回传不被 D4 卡死，新填写值仍拒绝', async () => {
    const h = harness({ watcher: legacyLiteralWatcher() });
    // 只改名：库内字面量沿用，正常保存
    await h.service.update(7, 1, { name: 'renamed' });
    expect(h.watchers.get(1)!.name).toBe('renamed');
    expect(h.service.decryptHeadersForCompare(h.watchers.get(1)!.headersJson))
      .toEqual({ 'X-Tpl': '{{EVIL}}', Accept: 'json' });
    // 未修改行随编辑回传（前端编辑对话框总是全量下发头行）：豁免
    const untouched = await h.service.update(7, 1, { headers: { 'X-Tpl': '{{EVIL}}', Accept: 'json' } });
    expect(untouched.headers).toEqual({ 'X-Tpl': '{{EVIL}}', Accept: 'json' });
    // 新填写的未识别占位符：仍拒绝（D4 对新输入不变）
    await expect(h.service.update(7, 1, { headers: { 'X-Tpl': '{{EVIL}}2' } })).rejects.toThrow(/不支持的占位符/);
    await expect(h.service.create(7, { ...baseInput, headers: { 'X-A': '{{EVIL}}' } })).rejects.toThrow(/不支持的占位符/);
  });

  it('复制：源行字面量继承到副本（create 不被 D4 卡死），副本落库仍是该字面量', async () => {
    const h = harness({ watcher: legacyLiteralWatcher() });
    const copy = await h.service.create(7, {
      ...baseInput, name: 'copy', headers: { 'X-Tpl': '{{EVIL}}', Accept: 'json' }, copyFrom: 1,
    });
    expect(copy.id).not.toBe(1);
    expect(h.service.decryptHeadersForCompare(h.watchers.get(copy.id)!.headersJson))
      .toEqual({ 'X-Tpl': '{{EVIL}}', Accept: 'json' });
  });

  it('存量字面量执行态原样直发（与旧版行为一致）', async () => {
    const h = harness({ watcher: legacyLiteralWatcher() });
    await h.service.runCheck(1);
    expect(h.probeExecute).toHaveBeenCalledTimes(1);
    expect(h.probeExecute.mock.calls[0]![0].headers).toEqual({ 'X-Tpl': '{{EVIL}}', Accept: 'json' });
  });
});

// ── Shell 脚本探针分流（V189，docs/plan/2026-11-10-shell-script-signal-watcher-technical-design.md）──

describe('SCRIPT 哨兵（V189）', () => {
  let projectsRoot: string;
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'mao-script-sentinel-'));
  });
  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  function scriptWatcher(overrides: Partial<SignalWatcher> = {}): SignalWatcher {
    return watcher({
      name: '磁盘',
      url: '',
      method: 'GET',
      intervalMinutes: 10,
      compareMode: 'JSON_FIELD',
      jsonPath: 'free',
      probeType: 'SCRIPT',
      scriptPath: 'ops/sentinels/disk.sh',
      scriptTimeoutSeconds: 60,
      ...overrides,
    });
  }

  function scriptProbeResult(overrides: Partial<ScriptProbeResult> = {}): ScriptProbeResult {
    return {
      ok: true,
      exitCode: 0,
      stdout: '{"free": 100}',
      stdoutBytes: Buffer.from('{"free": 100}', 'utf8'),
      error: null,
      durationMs: 30,
      ...overrides,
    };
  }

  function writeUserScript(userId: number, relative: string, content: string): string {
    const full = join(projectsRoot, String(userId), 'projects', relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  }

  function scriptInput(overrides: Partial<WatcherInput> = {}): WatcherInput {
    return {
      ...baseInput,
      name: '磁盘',
      url: '',
      intervalMinutes: 10,
      compareMode: 'JSON_FIELD',
      jsonPath: 'free',
      probeType: 'SCRIPT',
      scriptPath: 'ops/sentinels/disk.sh',
      scriptTimeoutSeconds: 60,
      ...overrides,
    };
  }

  it('create：落库 probeType/scriptPath/scriptTimeoutSeconds，HTTP 侧字段归空', async () => {
    const h = harness({ scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 100}\'\n');
    const view = await h.service.create(7, scriptInput());
    expect(view.probeType).toBe('SCRIPT');
    expect(view.scriptPath).toBe('ops/sentinels/disk.sh');
    expect(view.scriptTimeoutSeconds).toBe(60);
    expect(view.url).toBe('');
    expect(view.headers).toEqual({});
    const row = h.watchers.get(view.id)!;
    expect(row.probeType).toBe('SCRIPT');
    expect(row.headersJson).toBeNull();
    expect(row.body).toBeNull();
  });

  it('create：校验矩阵（STATUS_CODE/间隔<5/.. 段/绝对路径/文件不存在/超大小）', async () => {
    const h = harness({ scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo ok\n');
    const cases: Array<{ input: Partial<WatcherInput>; message: string }> = [
      { input: { compareMode: 'STATUS_CODE' }, message: 'HASH/JSON_FIELD' },
      { input: { intervalMinutes: 1 }, message: '5~1440' },
      { input: { scriptPath: 'ops/../other/check.sh' }, message: '..' },
      { input: { scriptPath: '/etc/passwd' }, message: '相对路径' },
      { input: { scriptPath: 'ops/sentinels/missing.sh' }, message: '脚本文件不存在' },
    ];
    for (const c of cases) {
      await expect(h.service.create(7, scriptInput(c.input))).rejects.toThrow(c.message);
    }
    // 超大小：256KB 上限
    writeUserScript(7, 'ops/sentinels/big.sh', 'x'.repeat(256 * 1024 + 1));
    await expect(h.service.create(7, scriptInput({ scriptPath: 'ops/sentinels/big.sh' }))).rejects.toThrow('过大');
  });

  it('runCheck：首轮建基线（exit_code=0、httpStatus=null），不触发', async () => {
    const h = harness({ watcher: scriptWatcher(), scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 100}\'\n');
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]).toMatchObject({ exitCode: 0, httpStatus: null, changed: 0 });
    // JSON_FIELD 判定值 = 提取路径取值的规范化文本（100），不是 stdout 全文
    expect(h.watchers.get(1)!.lastValueHash).toBe(sha256('100'));
    // 假执行器收到绝对路径与白名单 env（含 MAO_WATCHER_ID，不含后端进程变量）
    const call = h.scriptProbeExecute.mock.calls[0]![0]!;
    // macOS /var → /private/var 符号链接：用 realpath 对齐
    expect(call.scriptPath).toBe(realpathSync(join(projectsRoot, '7', 'projects', 'ops/sentinels/disk.sh')));
    expect(call.env.MAO_WATCHER_ID).toBe('1');
    expect(call.env.MAO_WATCHER_NAME).toBe('磁盘');
    expect(call.env.APP_SIGNAL_SECRET).toBeUndefined();
    expect(call.timeoutSeconds).toBe(60);
  });

  it('runCheck：变化触发会话，{url} 渲染脚本路径、{diff} 为 stdout 新旧片段', async () => {
    const h = harness({
      watcher: scriptWatcher({ lastValueHash: sha256('{"free": 100}'), lastValueSnippet: '{"free": 100}' }),
      scriptProbe: () => scriptProbeResult({ stdout: '{"free": 88}', stdoutBytes: Buffer.from('{"free": 88}', 'utf8') }),
      scriptProjectsRoot: projectsRoot,
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 88}\'\n');
    await h.service.runCheck(1);
    expect(h.openRun.run).toHaveBeenCalledTimes(1);
    const run = h.openRun.run.mock.calls[0]![0]!;
    expect(run.source).toBe('SIGNAL');
    expect(run.message).toContain('ops/sentinels/disk.sh');
    expect(run.message).toContain('88');
    expect(h.checks[0]).toMatchObject({ changed: 1, exitCode: 0, triggeredSessionId: 42 });
  });

  it('runCheck：非零退出判失败（error 取 stderr、check 行记 exit_code、计连败）', async () => {
    const h = harness({
      watcher: scriptWatcher(),
      scriptProbe: () => scriptProbeResult({ ok: false, exitCode: 3, stdout: null, stdoutBytes: null, error: '上游拒绝' }),
      scriptProjectsRoot: projectsRoot,
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'exit 3\n');
    await h.service.runCheck(1);
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]).toMatchObject({ exitCode: 3, httpStatus: null, error: '上游拒绝' });
  });

  it('runCheck：脚本路径软链逃逸到 projects 外 → 记失败不执行', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'mao-script-outside-'));
    try {
      const h = harness({ watcher: scriptWatcher(), scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
      const outsideScript = join(outsideDir, 'evil.sh');
      writeFileSync(outsideScript, 'echo pwned\n');
      // 项目内放一个指向 projects 外的软链
      const linkDir = join(projectsRoot, '7', 'projects', 'ops', 'sentinels');
      mkdirSync(linkDir, { recursive: true });
      symlinkSync(outsideScript, join(linkDir, 'disk.sh'));
      await h.service.runCheck(1);
      expect(h.scriptProbeExecute).not.toHaveBeenCalled();
      expect(h.openRun.run).not.toHaveBeenCalled();
      expect(h.checks).toHaveLength(1);
      expect(h.checks[0]!.error).toContain('越出项目工作区');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('runCheck：脚本文件被删 → 记失败走退避', async () => {
    const h = harness({ watcher: scriptWatcher(), scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    await h.service.runCheck(1);
    expect(h.scriptProbeExecute).not.toHaveBeenCalled();
    expect(h.checks).toHaveLength(1);
    expect(h.checks[0]!.error).toContain('脚本文件不存在');
  });

  it('runCheck：非零退出连续 5 次自动停用并发通知', async () => {
    const h = harness({
      watcher: scriptWatcher({ lastValueHash: sha256('base') }),
      scriptProbe: () => scriptProbeResult({ ok: false, exitCode: 2, stdout: null, stdoutBytes: null, error: 'boom' }),
      scriptProjectsRoot: projectsRoot,
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'exit 2\n');
    for (let i = 0; i < 5; i += 1) {
      await h.service.runCheck(1);
    }
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('update：切换 probeType/scriptPath 重置基线；仅改 timeout 不重置', async () => {
    const h = harness({ scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo ok\n');
    writeUserScript(7, 'ops/sentinels/disk2.sh', 'echo ok2\n');
    // harness 预置了 id=1 的默认 HTTP 哨兵：create 的新哨兵 id 是 2，必须按返回 id 取行
    const created = await h.service.create(7, scriptInput());
    const row = () => h.watchers.get(created.id)!;
    await h.service.update(7, created.id, {}).catch(() => undefined);
    // 直接模拟库里有基线：通过 repo patch 写入
    row().lastValueHash = sha256('base');
    row().lastValueSnippet = 'base';
    // 只改 timeout：不重置基线
    await h.service.update(7, created.id, { scriptTimeoutSeconds: 120 });
    expect(row().lastValueHash).toBe(sha256('base'));
    expect(row().scriptTimeoutSeconds).toBe(120);
    // 改脚本路径：重置基线
    await h.service.update(7, created.id, { scriptPath: 'ops/sentinels/disk2.sh' });
    expect(row().lastValueHash).toBeNull();
    expect(row().scriptPath).toBe('ops/sentinels/disk2.sh');
  });

  it('test：返回 exitCode 与 stdout 样例', async () => {
    const h = harness({ watcher: scriptWatcher(), scriptProbe: scriptProbeResult, scriptProjectsRoot: projectsRoot });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 100}\'\n');
    const result = await h.service.test(7, 1);
    expect(result).toMatchObject({ exitCode: 0, httpStatus: null, parseOk: true, sample: '{"free": 100}' });
    expect(result.valueHash).toBe(sha256('100'));
  });

  it('test：SCRIPT 样例取 stdout 前 500 字（§4 步骤 4.2 定案，与 HTTP 的 200 字口径分流）', async () => {
    const longStdout = 'x'.repeat(700);
    const h = harness({
      watcher: scriptWatcher({ compareMode: 'HASH', jsonPath: null }),
      scriptProbe: () => scriptProbeResult({ stdout: longStdout, stdoutBytes: Buffer.from(longStdout, 'utf8') }),
      scriptProjectsRoot: projectsRoot,
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo long\n');
    const result = await h.service.test(7, 1);
    expect(result.sample).toHaveLength(500);
    expect(result.sample).toBe('x'.repeat(500));
  });

  it('runCheck：Docker 模式走容器桥，不在宿主执行', async () => {
    const execute = vi.fn(async () => scriptProbeResult());
    const h = harness({
      watcher: scriptWatcher(),
      scriptProbe: scriptProbeResult,
      scriptProjectsRoot: projectsRoot,
      containerScriptProbe: { enabledFor: async () => true, execute },
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 100}\'\n');
    await h.service.runCheck(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, agentId: 3 }));
    expect(h.scriptProbeExecute).not.toHaveBeenCalled();
    expect(h.watchers.get(1)!.lastValueHash).toBe(sha256('100'));
  });

  it('runCheck：容器桥关闭时仍在宿主执行', async () => {
    const execute = vi.fn(async () => scriptProbeResult());
    const h = harness({
      watcher: scriptWatcher(),
      scriptProbe: scriptProbeResult,
      scriptProjectsRoot: projectsRoot,
      containerScriptProbe: { enabledFor: async () => false, execute },
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo \'{"free": 100}\'\n');
    await h.service.runCheck(1);
    expect(execute).not.toHaveBeenCalled();
    expect(h.scriptProbeExecute).toHaveBeenCalledTimes(1);
  });

  it('runCheck：容器基础设施失败不计入连败、不回退宿主', async () => {
    const execute = vi.fn(async () => { throw new ScriptProbeInfrastructureError('容器未就绪：docker down'); });
    const h = harness({
      watcher: scriptWatcher({ consecutiveFailures: 4 }),
      scriptProbe: scriptProbeResult,
      scriptProjectsRoot: projectsRoot,
      containerScriptProbe: { enabledFor: async () => true, execute },
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo ok\n');
    for (let i = 0; i < 5; i += 1) await h.service.runCheck(1);
    expect(h.scriptProbeExecute).not.toHaveBeenCalled();
    expect(h.recordFailure).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.watchers.get(1)!.status).toBe('ACTIVE');
    expect(h.watchers.get(1)!.consecutiveFailures).toBe(4);
    expect(h.watchers.get(1)!.lastCheckedAt).toBe('2026-11-10 13:00:00');
    expect(h.checks).toHaveLength(5);
    expect(h.checks[0]!.error).toContain('容器未就绪');
    expect(h.checks[0]!.exitCode).toBeNull();
  });

  it('runCheck：脚本文件不存在时不拉起容器', async () => {
    const execute = vi.fn(async () => scriptProbeResult());
    const h = harness({
      watcher: scriptWatcher(),
      scriptProjectsRoot: projectsRoot,
      containerScriptProbe: { enabledFor: async () => true, execute },
    });
    await h.service.runCheck(1);
    expect(execute).not.toHaveBeenCalled();
    expect(h.checks[0]!.error).toContain('脚本文件不存在');
  });

  it('test：容器基础设施失败只出现在返回值，不写库', async () => {
    const h = harness({
      watcher: scriptWatcher(),
      scriptProjectsRoot: projectsRoot,
      containerScriptProbe: {
        enabledFor: async () => true,
        execute: async () => { throw new ScriptProbeInfrastructureError('容器运行时版本待升级，本轮跳过'); },
      },
    });
    writeUserScript(7, 'ops/sentinels/disk.sh', 'echo ok\n');
    const result = await h.service.test(7, 1);
    expect(result.error).toContain('版本待升级');
    expect(h.checks).toHaveLength(0);
    expect(h.watchers.get(1)!.lastCheckedAt).toBeNull();
  });
});
