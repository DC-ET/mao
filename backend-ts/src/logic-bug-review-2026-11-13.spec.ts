import { describe, expect, it, vi } from 'vitest';

/**
 * 2026-11-13 逻辑 BUG 审查的存在性验证用例（对应 docs/code-review/2026-11-13-logic-bug-review-01.md）。
 *
 * 惯例同 logic-bug-review-2026-11-04/11：用例按「正确契约」书写，在缺陷代码上真实失败即确认缺陷；
 * 确认后以 `bugIt = it.fails` 固化为 expected-failure 保持 CI 绿色，修复后转正为普通 it 作为回归。
 *
 * 已修复并转正为回归（2026-11-13 当日修复）：
 * - BUG-1 outbound_delivery 卡死恢复判据 created_at→updated_at（V195）+ 终态回写 CAS + deliver 执行前状态重查
 * - BUG-2 weixin splitTextForWeixin 按 code point 累积字节，不再切断代理对
 * - BUG-5 glob_search 不可读子目录跳过续扫（根目录不可读仍整体报错）
 *
 * 仍未修复，以 it.fails 留档（二次复核降级为低价值，详见 review 文档「复核移除记录」，修复后转正）：
 * - BUG-3 admin analytics custom 区间只过正则不校验日历日（admin 前端已守，仅手写 API 可达）
 * - BUG-4 glob_search total_matched 截断口径（与 grep_search 共有的命名/语义问题，需两工具同改）
 *
 * BUG-6（zipSkillsForLocal archiver 无 error 监听）：其宿主为无任何调用方的死代码，已于 2026-11-13
 * 直接删除（真实端点走 writeSyncZip 已 pipeline 收口），原 it.fails 用例随删除一并移除。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatDateTime, isValidYmd } from './common/json.js';
import { resolveAnalyticsRange } from './admin/analytics-range.js';
import { OutboundDeliveryScheduler } from './openapi/outbound-delivery.scheduler.js';
import type { OutboundDelivery, OutboundSubscription } from './openapi/types.js';
import { splitTextForWeixin } from './weixin/send.service.js';
import { GlobSearchTool } from './harness/tool/impl/glob-search-tool.js';
import { PathSandbox } from './harness/safety/path-sandbox.js';

/** 未修复缺陷的固化：it.fails = expected-failure（CI 绿），修复后转正为普通 it。 */
const bugIt = it.fails;

/** 以 root 运行时 EACCES 类触发不可复现（权限不生效），相关用例跳过。 */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// ────────────────────────────────────────────────────────────────────────────
// BUG-1 outbound_delivery：在途投递行不被 recoverInterrupted 误判卡死（已修复，回归）
// ────────────────────────────────────────────────────────────────────────────

interface FakeRow extends OutboundDelivery { id: number; createdAt: string; updatedAt: string }

/**
 * 内存版 delivery repo，忠实镜像 MysqlOutboundDeliveryRepository 的 SQL 语义：
 * claim = PENDING→SENDING CAS；updated_at 为 ON UPDATE CURRENT_TIMESTAMP 范式
 * （V195）——认领与各回写都会刷新；recoverInterrupted = 「SENDING 且 updated_at < cutoff」复位回
 * PENDING 并把 next_retry_at 置为 now。
 */
function fakeRepos(row: FakeRow) {
  const rows = new Map<number, FakeRow>([[row.id, row]]);
  const touch = (r: FakeRow): void => { r.updatedAt = formatDateTime(new Date()); };
  const deliveryRepo = {
    async recoverInterrupted(cutoff: string, now: string): Promise<void> {
      for (const r of rows.values()) {
        if (r.status === 'SENDING' && r.updatedAt < cutoff) {
          r.status = 'PENDING';
          r.nextRetryAt = now;
          touch(r);
        }
      }
    },
    async listDue(now: string, limit: number): Promise<OutboundDelivery[]> {
      return [...rows.values()]
        .filter((r) => r.status === 'PENDING' && r.nextRetryAt != null && r.nextRetryAt <= now)
        .slice(0, limit);
    },
    async claim(id: number): Promise<boolean> {
      const r = rows.get(id);
      if (r == null || r.status !== 'PENDING') return false;
      r.status = 'SENDING';
      touch(r);
      return true;
    },
    async findById(id: number): Promise<OutboundDelivery | null> {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async scheduleRetry(id: number, attemptCount: number, httpStatus: number | null, error: string | null, nextRetryAt: string): Promise<boolean> {
      const r = rows.get(id)!;
      if (r.status !== 'SENDING') return false;
      r.status = 'PENDING';
      r.attemptCount = attemptCount;
      r.lastHttpStatus = httpStatus;
      r.lastError = error;
      r.nextRetryAt = nextRetryAt;
      touch(r);
      return true;
    },
    async markFailed(id: number, attemptCount: number, httpStatus: number | null, error: string | null): Promise<boolean> {
      const r = rows.get(id)!;
      if (r.status !== 'SENDING') return false;
      r.status = 'FAILED';
      r.attemptCount = attemptCount;
      r.lastHttpStatus = httpStatus;
      r.lastError = error;
      r.nextRetryAt = null;
      touch(r);
      return true;
    },
    async markSucceeded(id: number, attemptCount: number, httpStatus: number | null, now: string): Promise<boolean> {
      const r = rows.get(id)!;
      if (r.status !== 'SENDING') return false;
      r.status = 'SUCCEEDED';
      r.attemptCount = attemptCount;
      r.lastHttpStatus = httpStatus;
      r.lastError = null;
      r.sentAt = now;
      r.nextRetryAt = null;
      touch(r);
      return true;
    },
  };
  const subscription: OutboundSubscription = {
    id: 1,
    userId: 1,
    enabled: 1,
    secretCipher: 'cipher-text',
    targetUrl: 'https://hook.example/endpoint',
  };
  return {
    deliveryRepo,
    subscriptionRepo: {
      async findById(id: number): Promise<OutboundSubscription | null> {
        return subscription.id === id ? { ...subscription } : null;
      },
    },
  };
}

describe('BUG-1 outbound_delivery 在途投递行不被误判卡死（回归）', () => {
  it('首次发送仍在途时，运行期恢复 tick 不得复位该行导致二次投递', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t0 = new Date('2026-11-13T10:00:00+08:00');
      vi.setSystemTime(t0);
      // 行创建/最后推进于 10 分钟前，已进入第 2 次重试窗口（attempt=1，退避 5 分钟已到）
      const row: FakeRow = {
        id: 1,
        subscriptionId: 1,
        event: 'task.completed',
        payload: '{}',
        status: 'PENDING',
        attemptCount: 1,
        nextRetryAt: formatDateTime(t0),
        createdAt: formatDateTime(new Date(t0.getTime() - 10 * 60_000)),
        updatedAt: formatDateTime(new Date(t0.getTime() - 10 * 60_000)),
      };
      const { deliveryRepo, subscriptionRepo } = fakeRepos(row);
      const sendBodies: Array<Record<string, unknown>> = [];
      const sender = {
        send: vi.fn((_url: string, _secret: string, event: string, payload: Record<string, unknown>) => {
          sendBodies.push(payload);
          if (sendBodies.length === 1) {
            // 第一次投递挂起（对端慢/连接僵住，模拟 sender 10s 超时窗口内的在途状态）
            return new Promise<{ success: boolean }>(() => {});
          }
          return Promise.resolve({ success: true, httpStatus: 200 });
        }),
      };
      const executed: Array<() => void | Promise<void>> = [];
      const scheduler = new OutboundDeliveryScheduler({
        deliveryRepo: deliveryRepo as never,
        subscriptionRepo: subscriptionRepo as never,
        cipher: { decrypt: () => 'secret' } as never,
        sender: sender as never,
        execute: (fn) => { executed.push(fn); },
      });

      // 第 1 轮：恢复（no-op）→ 认领（updated_at 刷新为 t0）→ 派发投递（send 挂起，不 await deliver）
      await scheduler.dispatchDueDeliveries();
      const firstDelivery = executed.shift()!;
      void firstDelivery();
      await vi.waitFor(() => expect(sendBodies).toHaveLength(1));
      expect(row.status).toBe('SENDING');

      // 推进 61 秒（第 2 次重试期间）：恢复 tick 触发——行 updated_at=t0 晚于 cutoff，不得复位
      vi.setSystemTime(new Date(t0.getTime() + 61_000));
      await scheduler.dispatchDueDeliveries();
      if (executed.length > 0) void executed.shift()!();
      // 给可能出现的第二次 deliver 留出走到 send 的微任务窗口（真定时器，不与 fake Date 冲突）
      await new Promise((r) => setTimeout(r, 50));

      // 正确契约：在途发送（updated_at 随认领刷新）不被误判卡死，同一事件只投递一次
      expect(row.status, '在途行被恢复 tick 误复位').toBe('SENDING');
      expect(sendBodies, `同一事件被投递 ${sendBodies.length} 次`).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-2 weixin：字节硬切不落在代理对中间（已修复，回归）
// ────────────────────────────────────────────────────────────────────────────

function isLoneSurrogateChunk(chunk: string): boolean {
  for (let i = 0; i < chunk.length; i++) {
    const code = chunk.charCodeAt(i);
    const isSurrogate = code >= 0xd800 && code <= 0xdfff;
    const paired = isSurrogate && code <= 0xdbff && i + 1 < chunk.length && chunk.charCodeAt(i + 1) >= 0xdc00 && chunk.charCodeAt(i + 1) <= 0xdfff;
    if (isSurrogate && !paired) return true;
    if (isSurrogate && paired) i++; // 跳过低位代理
  }
  return false;
}

describe('BUG-2 splitTextForWeixin 不切断代理对（回归）', () => {
  it('分片必须是合法 UTF-8 文本（不得含孤立代理/往返无损）', () => {
    // 'a😀b' = 1 + 4 + 1 字节；maxBytes=4 时预算恰耗尽在代理对之前
    const chunks = splitTextForWeixin('a😀b', 4);
    for (const chunk of chunks) {
      expect(isLoneSurrogateChunk(chunk), `分片含孤立代理: ${JSON.stringify(chunk)}`).toBe(false);
      expect(Buffer.from(chunk, 'utf8').toString('utf8'), `分片 UTF-8 往返失真: ${JSON.stringify(chunk)}`).toBe(chunk);
    }
    expect(chunks.join('')).toBe('a😀b');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-3 analytics custom 区间不校验日历日（未修复，留档）
// ────────────────────────────────────────────────────────────────────────────

describe('BUG-3 analytics custom 区间不校验真实日历日', () => {
  bugIt('2026-02-30 应拒绝（回落默认窗口），而非按溢出日 03-02 漂移', () => {
    // 仓库契约：common/json.ts isValidYmd 明确拒绝 2026-02-30（Date.UTC 溢出到别的日子）
    expect(isValidYmd('2026-02-30')).toBe(false);
    expect(resolveAnalyticsRange('custom', { start: '2026-02-30', end: '2026-02-30' }, '2026-03-10')).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-4 glob_search total_matched 截断口径（未修复，留档）
// ────────────────────────────────────────────────────────────────────────────

function makeGlobTool(root: string): GlobSearchTool {
  return new GlobSearchTool(new PathSandbox(root));
}

async function runGlob(root: string, args: Record<string, unknown>): Promise<{ files: string[]; truncated?: boolean; total_matched?: number; error?: string }> {
  const tool = makeGlobTool(root);
  const raw = await (tool as unknown as { executeWithWorkspace(json: string, workspace: string | null): Promise<string> })
    .executeWithWorkspace(JSON.stringify(args), null);
  return JSON.parse(raw);
}

describe('BUG-4 glob_search total_matched 截断口径', () => {
  bugIt('截断时 total_matched 应为真实匹配总数，而非返回条数', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glob-bug4-'));
    try {
      for (let i = 0; i < 150; i++) writeFileSync(join(root, `f${i}.txt`), 'x');
      const result = await runGlob(root, { pattern: '*.txt' });
      expect(result.files).toHaveLength(100);
      expect(result.truncated).toBe(true);
      expect(result.total_matched).toBe(150);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-5 glob_search 不可读子目录跳过续扫（已修复，回归）
// ────────────────────────────────────────────────────────────────────────────

describe.skipIf(IS_ROOT)('BUG-5 glob_search 不可读目录容错（回归）', () => {
  it('单个不可读子目录不得让整次搜索丢弃其他结果', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glob-bug5-'));
    try {
      writeFileSync(join(root, 'a.txt'), 'x');
      mkdirSync(join(root, 'locked'));
      writeFileSync(join(root, 'locked', 'b.txt'), 'x');
      chmodSync(join(root, 'locked'), 0o000);

      const result = await runGlob(root, { pattern: '**/*.txt' });
      expect(result.error).toBeUndefined();
      expect(result.files).toContain('a.txt');
    } finally {
      chmodSync(join(root, 'locked'), 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('根目录本身不可读仍整体报错（不静默返回空结果）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'glob-bug5-root-'));
    chmodSync(root, 0o000);
    try {
      const result = await runGlob(root, { pattern: '*.txt' });
      expect(result.error).toBeDefined();
      expect(result.files).toEqual([]);
    } finally {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// BUG-6 zipSkillsForLocal：已随死代码删除（宿主无任何调用方，真实端点走 writeSyncZip 已收口）
// ────────────────────────────────────────────────────────────────────────────
