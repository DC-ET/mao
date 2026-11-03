import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from './common/http-error.js';
import { formatDateTime } from './common/json.js';
import { MAX_DIFF_BYTES, GitCommitMessageService } from './file/git-commit-message.service.js';
import { GitWriteOperationService } from './file/git-write-operation.service.js';
import { WorkspaceBrowseService } from './file/workspace-browse.service.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';
import {
  ScheduledTaskService,
  buildCronPreview,
  isOneShotCron,
  type ScheduledTask,
} from './schedule/scheduled-task.service.js';
import {
  WATCHER_DISABLE_AFTER_FAILURES,
  WatcherService,
} from './signal/watcher.service.js';
import { SignalSecretCipher } from './signal/signal-cipher.js';
import type { SignalWatcher } from './signal/types.js';
import { useTmpDirOutsideRepo } from './testing/tmp-dir.js';
import { registerLlmCallRoutes } from './usage/llm-call.routes.js';

/**
 * 2026-11-03 逻辑 BUG 审查的验证用例（对应 docs/code-review/2026-11-03-logic-bug-review.md）。
 *
 * 每个用例按「正确行为」书写，用 it.fails 固化为 expected-failure：
 * - 现在跑：用例体断言失败 → it.fails 视为通过（证明 BUG 真实存在）；
 * - 修复后：用例体断言通过 → it.fails 转为失败，提醒把 `const bugIt = it.fails`
 *   改回 `it`，让这些用例变成常驻回归。
 * 临时去掉 .fails 即可在输出里看到 N 条真实失败（报告里贴的就是这份输出）。
 *
 * 原 BUG-8（numstat ` => `）/ BUG-10（truncated 误报）/ BUG-11（空文件行数）经复核
 * 缺陷真实但修复价值不高，已移出报告正榜（见文档「已核查并排除」），用例同步删除。
 */
const bugIt = it.fails;

const SECRET = 'review-secret';

// ────────────────────────────────────────────────────────────────────────────
// BUG-1 一次性任务「已入队、待执行」期间重新启用会重开档期 → 同一档跑两次
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-1 一次性任务排队待执行时被重开档期', () => {
  bugIt('QUEUED 待执行期间只改 status 的保存必须保持 nextFireTime 为空', async () => {
    const row: ScheduledTask = {
      id: 1,
      userId: 7,
      agentId: 5,
      sessionId: 11,
      name: '年度提醒',
      prompt: 'hello',
      cronExpression: '0 0 9 15 8 ?',
      once: 1,
      status: 'ACTIVE',
      fireCount: 1,
      nextFireTime: null,   // 已入队：executeTask 的 busy 分支清空了档期
      finished: 0,
      finishedAt: null,
      consecutiveFailures: 0,
    };
    const store = {
      selectById: vi.fn(async (id: number) => (id === 1 ? { ...row } : null)),
      updateById: vi.fn(async (patch: Partial<ScheduledTask> & { id: number }) => {
        Object.assign(row, patch);
      }),
      // 没有待重试；但队列里有一条尚未结算的 QUEUED run
      hasPendingRetry: vi.fn(async () => false),
      oldestQueuedRun: vi.fn(async () => ({ id: 9, taskId: 1, status: 'QUEUED' })),
    };
    const service = new ScheduledTaskService(
      store as never, null as never, null as never, null as never, null as never,
      null as never, null as never, null as never,
    );

    // 桌面/管理后台启停开关只发 { status }
    await service.updateTask(1, 7, null, null, null, 'PAUSED');
    await service.updateTask(1, 7, null, null, null, 'ACTIVE');

    // 队内那一档还没结算，不允许再排新档期（否则 listDue 与队列会各跑一次）
    expect(row.nextFireTime).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-2 哨兵凭据解密失败被吞成「空请求头 / 空 body」，探针照发 → 假变化触发
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-2 哨兵凭据解密失败被静默吞掉', () => {
  bugIt('解密失败必须按本轮失败处理，不得去掉鉴权头后照发探针', async () => {
    // 模拟 APP_SIGNAL_SECRET 轮换/丢失：密文由旧密钥加密，服务用新密钥解
    const rotated = new SignalSecretCipher('rotated-secret');
    const h = makeSignalHarness({
      headersJson: rotated.encrypt(JSON.stringify({ authorization: 'Bearer secret' })),
      lastValueHash: 'old-hash',
    });

    await h.service.runCheck(1);

    // 期望：解密失败 → 记一次失败并退避，不访问目标、不触发 Agent
    expect(h.probeExecute).not.toHaveBeenCalled();
    expect(h.openRun.run).not.toHaveBeenCalled();
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-3 5 段 cron 的一次性任务不会被识别 → 每年重复触发
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-3 5 段 cron 一次性判定失效', () => {
  function fakeStore(): { store: never; inserted: ScheduledTask[] } {
    const inserted: ScheduledTask[] = [];
    const store = {
      insert: vi.fn(async (row: ScheduledTask) => {
        inserted.push(row);
        return 1;
      }),
    };
    return { store: store as never, inserted };
  }

  it('6 段形态（既有口径）确实被识别为一次性任务', () => {
    expect(isOneShotCron('0 0 8 15 8 ?')).toBe(true);
  });

  bugIt('等价的 5 段形态 0 8 15 8 * 也必须识别为一次性任务', () => {
    // croner 对两者都解析为「每年 8-15 08:00」，once 判定不应因书写段数而不同
    expect(buildCronPreview('0 8 15 8 *').oneShot).toBe(true);
    expect(isOneShotCron('0 8 15 8 *')).toBe(true);
  });

  bugIt('createTask 用 5 段一次性 cron 时必须置 once=1', async () => {
    const { store, inserted } = fakeStore();
    const service = new ScheduledTaskService(
      store, null as never, null as never, null as never, null as never,
      null as never, null as never, null as never,
    );
    const task = await service.createTask(7, 5, 11, '年度提醒', 'hello', '0 8 15 8 *');
    expect(task.once).toBe(1);
    expect(inserted[0]?.once).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-4 createTask 接受「永远排不出下次触发」的 cron → 永久悬空的死任务
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-4 创建永不触发的定时任务', () => {
  it('预览接口对 2 月 30 日明确返回 valid=false', () => {
    const preview = buildCronPreview('0 0 0 30 2 *');
    expect(preview.valid).toBe(false);
    expect(preview.nextFireTimes).toHaveLength(0);
  });

  bugIt('createTask 对无法计算下次触发时间的表达式必须抛 PARAM_INVALID', async () => {
    const { store } = fakeStoreForCreate();
    const service = new ScheduledTaskService(
      store, null as never, null as never, null as never, null as never,
      null as never, null as never, null as never,
    );
    await expect(
      service.createTask(7, 5, 11, '2 月 30 日', 'hello', '0 0 0 30 2 *'),
    ).rejects.toThrow();
  });
});

function fakeStoreForCreate(): { store: never } {
  const store = { insert: vi.fn(async () => 1) };
  return { store: store as never };
}

// ────────────────────────────────────────────────────────────────────────────
// BUG-5 信号哨兵「触发失败」分支先把连败清零再 +1 → 连败永远停在 1
// ────────────────────────────────────────────────────────────────────────────
interface SignalHarness {
  service: WatcherService;
  row: SignalWatcher;
  notifyDisabled: ReturnType<typeof vi.fn>;
  openRun: { run: ReturnType<typeof vi.fn> };
  probeExecute: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
}

/**
 * 单行状态的仓储替身：markChecked / recordFailure 与 signal.repository.ts 的
 * 两条 SQL 同义（markChecked 在「库内值 == 传入快照」时清零；recordFailure 对同一行 +1
 * 并判停用阈值）。生产里两处操作的是同一行，替身也必须是同一行，否则会掩盖清零行为。
 */
function makeSignalHarness(overrides: Partial<SignalWatcher> = {}): SignalHarness {
  const row: SignalWatcher = {
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
    promptTemplate: 'changed {diff}',
    status: 'ACTIVE',
    lastValueHash: 'old-hash',
    lastValueSnippet: 'old',
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    triggerMode: 'NEW_SESSION',
    reuseSessionId: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
  let checkId = 100;
  let bodySeq = 0;
  const watcherRepo = {
    findById: vi.fn(async (id: number) => (id === row.id ? { ...row } : null)),
    findOwned: vi.fn(async (id: number, userId: number) => (
      id === row.id && userId === row.userId ? { ...row } : null
    )),
    markChecked: vi.fn(async (
      _id: number,
      patch: { lastValueHash: string | null; lastValueSnippet: string | null; lastChangedAt: string | null; consecutiveFailures: number },
    ) => {
      row.lastValueHash = patch.lastValueHash;
      row.lastValueSnippet = patch.lastValueSnippet;
      row.lastChangedAt = patch.lastChangedAt;
      row.lastCheckedAt = formatDateTime(new Date());
      if (row.consecutiveFailures === patch.consecutiveFailures) row.consecutiveFailures = 0;
    }),
    recordFailure: vi.fn(async (_id: number, _backoffMinutes: number, threshold: number) => {
      if (row.status !== 'ACTIVE') return null;
      row.consecutiveFailures += 1;
      if (row.consecutiveFailures >= threshold) row.status = 'DISABLED';
      return { ...row };
    }),
    update: vi.fn(async (_id: number, _userId: number, patch: Partial<SignalWatcher>) => {
      Object.assign(row, patch);
      return true;
    }),
  };
  const checkRepo = {
    insert: vi.fn(async () => checkId++),
    updateHash: vi.fn(async () => undefined),
    markChanged: vi.fn(async () => undefined),
    markTriggered: vi.fn(async () => undefined),
    markWarning: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
    countRecentTriggers: vi.fn(async () => 0),
    remove: vi.fn(async () => undefined),
  };
  const probe = {
    execute: vi.fn(async () => {
      const body = `value-${bodySeq++}`;
      return { ok: true, httpStatus: 200, body, bodyBytes: Buffer.from(body, 'utf8'), error: null, durationMs: 3 };
    }),
  };
  const openRun = {
    run: vi.fn(async () => {
      throw new Error('预算不足，任务被拒绝');
    }),
  };
  const notifyDisabled = vi.fn(async () => undefined);
  const service = new WatcherService({
    watcherRepo: watcherRepo as never,
    checkRepo: checkRepo as never,
    cipher: new SignalSecretCipher(SECRET),
    openRun: openRun as never,
    disableNotifier: { notifyWatcherDisabled: notifyDisabled } as never,
    getSession: async () => null,
    probe: probe as never,
  });
  return { service, row, notifyDisabled, openRun, probeExecute: probe.execute, recordFailure: watcherRepo.recordFailure };
}

describe('BUG-5 哨兵触发失败连败被清零', () => {
  bugIt('连续 5 次触发失败后 consecutive_failures 必须累加到 5 并自动停用', async () => {
    const h = makeSignalHarness();
    for (let i = 0; i < WATCHER_DISABLE_AFTER_FAILURES; i += 1) {
      await h.service.runCheck(1);
    }
    expect(h.openRun.run).toHaveBeenCalledTimes(WATCHER_DISABLE_AFTER_FAILURES);
    expect(h.row.consecutiveFailures).toBe(WATCHER_DISABLE_AFTER_FAILURES);
    expect(h.row.status).toBe('DISABLED');
    expect(h.notifyDisabled).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-6 哨兵停用后重新启用不重置 last_checked_at → 退避写入的未来时刻把轮询推迟 17×间隔
// ────────────────────────────────────────────────────────────────────────────
/** 复刻 signal.repository.ts:listDue 的到期判定，用来断言「启用后多久能再次轮询」。 */
function isDue(row: SignalWatcher, atMs: number): boolean {
  if (row.status !== 'ACTIVE') return false;
  if (row.lastCheckedAt == null) return true;
  return row.lastCheckedAt < formatDateTime(new Date(atMs - row.intervalMinutes * 60_000));
}

describe('BUG-6 哨兵重新启用后仍被旧的退避时刻挡住', () => {
  bugIt('从 DISABLED 切回 ACTIVE 后，一个正常间隔内必须重新到期', async () => {
    // 第 5 次探针失败时 recordFailure 会写 last_checked_at = NOW() + 16×interval
    const h = makeSignalHarness({
      status: 'DISABLED',
      consecutiveFailures: WATCHER_DISABLE_AFTER_FAILURES,
      lastValueHash: 'hash-before-disable',
      lastCheckedAt: '2099-01-01 00:00:00',
    });

    await h.service.setStatus(7, 1, 'ACTIVE');

    expect(h.row.status).toBe('ACTIVE');
    // 启用后等一个间隔 + 1 分钟就应再次到期（当前实现要等到 2099 年）
    expect(isDue(h.row, Date.now() + (h.row.intervalMinutes + 1) * 60_000)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-7 UTF-8 截断 off-by-one：留下孤立首字节 → 乱码 + 超出上限 → 提交信息生成失败
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-7 diff 截断在多字节字符中间时留下 U+FFFD', () => {
  bugIt('截断后的 diff 必须不超上限、不含替换字符，且能通过提交信息校验', async () => {
    const repo = useTmpDirOutsideRepo('mao-review-utf8-');
    const fileName = 'big.txt';
    const header = `--- /dev/null\n+++ b/${fileName}\n`;
    // 让 2 字节字符 'é' 的首字节正好落在 MAX_DIFF_BYTES 的最后一个位置
    const asciiCount = MAX_DIFF_BYTES - Buffer.byteLength(header, 'utf8') - 1;
    writeFileSync(
      join(repo, fileName),
      Buffer.concat([Buffer.from('a'.repeat(asciiCount), 'utf8'), Buffer.from('é', 'utf8'), Buffer.from('tail', 'utf8')]),
    );

    const service = new GitWriteOperationService(
      null as never, null as never, null as never, null as never, null as never,
    );
    const input = await service.buildCommitInput(repo, new Map([[
      fileName,
      { path: fileName, changeType: 'CREATED', insertions: 1, deletions: 0, binary: false, untracked: true },
    ]]));

    const diff = input.files[0]!.diff ?? '';
    expect(Buffer.byteLength(diff, 'utf8')).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(diff).not.toContain('\uFFFD');
    expect(input.diffBytes).toBeLessThanOrEqual(MAX_DIFF_BYTES);
    expect(() => new GitCommitMessageService(null as never, null as never, null as never, null as never).validateInput(input)).not.toThrow();
  });

  bugIt('同源副本：文件预览的 512KB 截断同样不能留下替换字符', async () => {
    const ws = useTmpDirOutsideRepo('mao-review-utf8-preview-');
    // 单行 512KB：512×1024−1 个 ASCII + 2 字节字符，让首字节落在截断点
    writeFileSync(join(ws, 'huge.txt'), Buffer.concat([
      Buffer.from('a'.repeat(512 * 1024 - 1), 'utf8'),
      Buffer.from('é', 'utf8'),
    ]));
    const service = new WorkspaceBrowseService(new PathSandbox(ws));

    const result = await service.readFile(ws, 'huge.txt', 0, 5000);
    const bytes = Buffer.byteLength(result.content, 'utf8');
    expect(bytes).toBeLessThanOrEqual(512 * 1024);
    expect(result.content).not.toContain('\uFFFD');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-8 用量自定义周期只校验日期形状，不校验日历 → 非法日期直达 SQL（500 / 窗口错位）
// ────────────────────────────────────────────────────────────────────────────
describe('BUG-8 用量自定义周期接受非法日历日', () => {
  bugIt('2026-02-31 必须按非法入参回落默认周期 last30，而不是透传给 service', async () => {
    const summaryForUser = vi.fn(async () => ({
      range: 'last30', totals: {}, byModel: [], byScene: [], byAgent: [],
    }));
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (request, _reply, done) => {
      (request as unknown as { userId: number }).userId = 7;
      done();
    });
    registerLlmCallRoutes(app, {
      llmCallService: { summaryForUser } as never,
      permissionService: {} as never,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/llm-calls/me/summary?range=custom&startDate=2026-02-31&endDate=2026-02-31',
    });

    expect(res.statusCode).toBe(200);
    expect(summaryForUser).toHaveBeenCalledWith(7, 'custom', undefined);
  });
});
