import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ReplayManifest } from '@mao/contracts';
import { ErrorCode } from '../common/error-code.js';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { Session } from '../session/types.js';
import { BrowserReplayService } from './browser-replay.service.js';
import { BrowserReplayCatalogService, type BrowserReplayCatalogDeps } from './browser-replay-catalog.service.js';

const OWNER = 7;
const OTHER = 8;

/** 进程本地时区解析：catalog 的窗口换算同口径（生产由 config/process-timezone.ts 固定 Asia/Shanghai）。 */
function ts(local: string): number {
  return new Date(local.replace(' ', 'T')).getTime();
}

/** liveId = L<startedAt 毫秒>（sidecar 分配规则，目录名必须匹配 /^L\d+$/）。 */
function liveId(local: string): string {
  return `L${ts(local)}`;
}

const WINDOW = { dateFrom: '2026-11-10', dateTo: '2026-11-12' };

function writeLive(
  root: string,
  userId: number,
  sessionId: number,
  liveId: string,
  overrides: Partial<ReplayManifest> = {},
): void {
  const dir = path.join(root, String(userId), String(sessionId), '.mao-browser', 'replay', liveId);
  mkdirSync(dir, { recursive: true });
  const manifest: ReplayManifest = {
    version: 1,
    liveId,
    sessionId,
    startedAt: Number(liveId.slice(1)),
    endedAt: Number(liveId.slice(1)) + 60_000,
    frameCount: 3,
    durationMs: 60_000,
    approxBytes: 1024,
    cliSessions: ['default'],
    urls: ['https://example.test/page'],
    truncated: false,
    ...overrides,
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

function fakeSessions(rows: Array<{ id: number; userId: number; agentId: number; title: string | null }>): Session[] {
  return rows.map((row) => ({ ...row, executionMode: 'CLOUD' }) as unknown as Session);
}

interface Harness {
  service: BrowserReplayCatalogService;
  candidateFilter: () => unknown[];
  getSessionsByIds: ReturnType<typeof vi.fn>;
}

function harness(root: string, opts?: {
  sessions?: Array<{ id: number; userId: number; agentId: number; title: string | null }>;
  manifestReadCap?: number;
}): Harness {
  const sessions = opts?.sessions ?? [
    { id: 101, userId: OWNER, agentId: 5, title: '会话甲' },
    { id: 102, userId: OWNER, agentId: 6, title: null },
  ];
  const candidateFilter: unknown[] = [];
  const getSessionsByIds = vi.fn(async (ids: number[]) =>
    fakeSessions(sessions).filter((s) => ids.includes(s.id as number)));
  const deps: BrowserReplayCatalogDeps = {
    runtimeResolver: RuntimeDataResolver.forTest(root, path.join(root, 'home')),
    replayService: new BrowserReplayService(RuntimeDataResolver.forTest(root, path.join(root, 'home'))),
    sessionService: { getSessionsByIds },
    sessionRepository: {
      selectReplayCandidateSessions: vi.fn(async (filter: unknown) => {
        candidateFilter.push(filter);
        // 只回放 filter 里选中的会话（模拟 DB 的 CLOUD + 时间窗 + 筛选）
        const f = filter as { userId?: number | null; sessionId?: number | null };
        return sessions
          .filter((s) => (f.userId == null || s.userId === f.userId))
          .filter((s) => (f.sessionId == null || s.id === f.sessionId))
          .map((s) => ({ id: s.id, userId: s.userId, agentId: s.agentId, title: s.title }));
      }),
    },
    userLookup: { findByIds: async (ids: number[]) => ids.map((id) => ({ id, username: `user${id}` })) },
    agentLookup: { findByIds: async (ids: number[]) => ids.map((id) => ({ id, name: `agent${id}` })) },
    ...(opts?.manifestReadCap != null ? { manifestReadCap: opts.manifestReadCap } : {}),
  };
  return { service: new BrowserReplayCatalogService(deps), candidateFilter: () => candidateFilter, getSessionsByIds };
}

/** 造一轮典型数据：会话 101 三场（结算/截断/未结算）+ 窗外一场 + 损坏目录；会话 102 一场；他人 201 一场。 */
function seed(root: string): void {
  writeLive(root, OWNER, 101, liveId('2026-11-11 09:00:00'));
  writeLive(root, OWNER, 101, liveId('2026-11-11 10:00:00'), { truncated: true, urls: ['https://truncated.test'] });
  writeLive(root, OWNER, 101, liveId('2026-11-12 23:30:00'), { endedAt: null, durationMs: null });
  // 窗外场（liveId 时间戳预过滤就应排除，不读 manifest）
  writeLive(root, OWNER, 101, liveId('2026-11-01 09:00:00'));
  // liveId 在窗内但 manifest.startedAt 在窗外：二次精确校验排除
  writeLive(root, OWNER, 101, liveId('2026-11-11 09:30:00'), { startedAt: ts('2026-11-01 09:30:00') });
  // 非 L\d+ 目录名 + liveId 不匹配 + 坏 JSON：容错跳过
  const badRoot = path.join(root, String(OWNER), '101', '.mao-browser', 'replay');
  mkdirSync(path.join(badRoot, 'not-a-live'), { recursive: true });
  writeLive(root, OWNER, 101, liveId('2026-11-11 11:00:00'), { liveId: 'Lmismatch' } as Partial<ReplayManifest>);
  mkdirSync(path.join(badRoot, liveId('2026-11-11 11:30:00')), { recursive: true });
  writeFileSync(path.join(badRoot, liveId('2026-11-11 11:30:00'), 'manifest.json'), '{ broken json');
  writeLive(root, OWNER, 102, liveId('2026-11-11 08:00:00'));
  writeLive(root, OTHER, 201, liveId('2026-11-11 09:00:00'));
}

describe('BrowserReplayCatalogService（跨会话回放列表聚合，方案 2026-11-27 §4.3）', () => {
  it('owner 列表：时间窗双重过滤 + 倒序 + 未结算/截断场 + 元数据补齐', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-'));
    seed(root);
    const { service } = harness(root);

    const result = await service.listForUser(OWNER, WINDOW, 1, 20);

    expect(result.total).toBe(4);
    expect(result.records.map((r) => r.liveId)).toEqual([
      liveId('2026-11-12 23:30:00'),
      liveId('2026-11-11 10:00:00'),
      liveId('2026-11-11 09:00:00'),
      liveId('2026-11-11 08:00:00'),
    ]);
    // 他人目录不可见
    expect(result.records.every((r) => r.sessionId !== 201)).toBe(true);
    const unsettled = result.records[0]!;
    expect(unsettled.sessionId).toBe(101);
    expect(unsettled.endedAt).toBeNull();
    expect(unsettled.durationMs).toBeNull();
    // 会话 102 无标题（排在最末）
    expect(result.records[3]!.sessionTitle).toBeNull();
    const truncated = result.records[1]!;
    expect(truncated.truncated).toBe(true);
    expect(truncated.pageUrl).toBe('https://truncated.test');
    const settled = result.records[2]!;
    expect(settled.sessionId).toBe(101);
    expect(settled.sessionTitle).toBe('会话甲');
    expect(settled.agentName).toBe('agent5');
    expect(settled.executionMode).toBe('CLOUD');
    expect(settled.pageUrl).toBe('https://example.test/page');
    expect(settled.frameCount).toBe(3);
    expect(settled.approxBytes).toBe(1024);
    // owner 列表不带 userId/username（仅 admin）
    expect('userId' in settled).toBe(false);
  });

  it('窗外场（liveId 预过滤）与 manifest.startedAt 越界场均不出现', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-win-'));
    seed(root);
    const { service } = harness(root);
    const result = await service.listForUser(OWNER, WINDOW, 1, 20);
    expect(result.records.map((r) => r.liveId)).not.toContain(liveId('2026-11-01 09:00:00'));
    expect(result.records.map((r) => r.liveId)).not.toContain(liveId('2026-11-11 09:30:00'));
  });

  it('分页：size/page 切分与 total 一致', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-page-'));
    seed(root);
    const { service } = harness(root);
    const first = await service.listForUser(OWNER, WINDOW, 1, 2);
    const second = await service.listForUser(OWNER, WINDOW, 2, 2);
    expect(first.records).toHaveLength(2);
    expect(first.total).toBe(4);
    expect(second.records).toHaveLength(2);
    expect(first.records.map((r) => r.liveId)).not.toEqual(second.records.map((r) => r.liveId));
  });

  it('孤儿会话（runtime 有目录但 DB 无会话）被过滤且不占 total', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-orphan-'));
    seed(root);
    // 会话 103 有录制目录，但 sessions 元数据里没有它
    writeLive(root, OWNER, 103, liveId('2026-11-11 12:00:00'));
    const { service } = harness(root, {
      sessions: [
        { id: 101, userId: OWNER, agentId: 5, title: '会话甲' },
        { id: 102, userId: OWNER, agentId: 6, title: null },
      ],
    });
    const result = await service.listForUser(OWNER, WINDOW, 1, 20);
    expect(result.total).toBe(4);
    expect(result.records.some((r) => r.sessionId === 103)).toBe(false);
  });

  it('owner 列表按 user_id 收敛：群聊产物落在发言者 runtime 目录也不可见（方案 §7 越权枚举）', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-group-'));
    seed(root);
    // 群聊会话 301 归属 OTHER，但其运行期产物按「发言者运行身份」落在 OWNER 目录下
    writeLive(root, OWNER, 301, liveId('2026-11-11 13:00:00'));
    const { service } = harness(root, {
      sessions: [
        { id: 101, userId: OWNER, agentId: 5, title: '会话甲' },
        { id: 102, userId: OWNER, agentId: 6, title: null },
        { id: 301, userId: OTHER, agentId: 7, title: '群聊会话' },
      ],
    });
    const result = await service.listForUser(OWNER, WINDOW, 1, 20);
    expect(result.total).toBe(4); // 301 不计入 total
    expect(result.records.some((r) => r.sessionId === 301)).toBe(false);
  });

  it('30s 结果缓存命中；refresh=1 绕过读写', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-cache-'));
    seed(root);
    const { service, getSessionsByIds } = harness(root);

    await service.listForUser(OWNER, WINDOW, 1, 20);
    await service.listForUser(OWNER, WINDOW, 1, 20);
    expect(getSessionsByIds).toHaveBeenCalledTimes(1); // 第二次命中缓存，未重新扫描

    await service.listForUser(OWNER, WINDOW, 1, 20, true);
    expect(getSessionsByIds).toHaveBeenCalledTimes(2);

    // 不同分页是不同缓存 key
    await service.listForUser(OWNER, WINDOW, 2, 20);
    expect(getSessionsByIds).toHaveBeenCalledTimes(3);
  });

  it('manifest 读取超上限：返回截断标记而不是拖死接口', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-cap-'));
    seed(root);
    const { service } = harness(root, { manifestReadCap: 2 });
    const result = await service.listForUser(OWNER, WINDOW, 1, 20);
    expect(result.truncatedCandidates).toBe(true);
    expect(result.records.length).toBeLessThan(4);
  });

  it('admin 列表：DB 候选筛选条件下传 + username/agentName 补齐 + 非候选目录不扫', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-admin-'));
    seed(root);
    const { service, candidateFilter } = harness(root);

    const result = await service.listForAdmin(
      { userId: OWNER, agentId: 5, sessionId: 101, keyword: '会话', ...WINDOW },
      1,
      20,
    );

    // 候选查询收到转换后的筛选条件（时间窗为 Shanghai 墙钟字符串，manifest 侧再精确过滤）
    const filter = candidateFilter()[0] as {
      userId: number; agentId: number; sessionId: number; keyword: string;
      activityFrom: string; activityToExclusive: string;
    };
    expect(filter.userId).toBe(OWNER);
    expect(filter.agentId).toBe(5);
    expect(filter.sessionId).toBe(101);
    expect(filter.keyword).toBe('会话');
    expect(filter.activityFrom).toBe('2026-11-10 00:00:00');
    expect(filter.activityToExclusive).toBe('2026-11-13 00:00:00');

    expect(result.records).toHaveLength(3); // 只含候选会话 101 的三场（11-12/11-11x2）
    expect(result.records.every((r) => r.sessionId === 101)).toBe(true);
    expect(result.records[0]!.userId).toBe(OWNER);
    expect(result.records[0]!.username).toBe('user7');
    expect(result.records[0]!.agentName).toBe('agent5');
  });

  it('admin 候选会话触顶（5000）返回 truncatedCandidates', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-cap5k-'));
    seed(root);
    const sessions = Array.from({ length: 5000 }, (_, i) => ({
      id: 1000 + i, userId: OWNER, agentId: 5, title: `s${i}`,
    }));
    const { service } = harness(root, { sessions });
    const result = await service.listForAdmin(WINDOW, 1, 20);
    expect(result.truncatedCandidates).toBe(true);
  });

  it('非法时间范围 → PARAM_INVALID 业务错误', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'mao-replay-catalog-badrange-'));
    seed(root);
    const { service } = harness(root);
    await expect(service.listForUser(OWNER, { range: '3H' }, 1, 20)).rejects.toMatchObject({
      name: 'BusinessException',
      code: ErrorCode.PARAM_INVALID.code,
    });
  });
});
