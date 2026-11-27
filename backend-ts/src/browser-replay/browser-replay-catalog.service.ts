import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserReplayListItem, BrowserReplayListResult, ReplayManifest } from '@mao/contracts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { collectEntityIds, queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { FastifyRequest } from 'fastify';
import type { ActivityWindow } from '../session/message-search.js';
import { resolveActivityWindow } from '../session/message-search.js';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { SessionRepository } from '../session/session.repository.js';
import type { AgentRef, Session, UserRef } from '../session/types.js';
import { LIVE_ID_PATTERN, parseReplayManifest } from './browser-replay.service.js';
import type { BrowserReplayService } from './browser-replay.service.js';

/**
 * 浏览器回放跨会话列表聚合（技术方案 2026-11-27 §4.3）：runtime 目录即数据源，零 DB 索引表。
 * 候选会话（admin 走 DB 时间窗超集 / owner 走本人 runtime 目录）→ liveId 时间戳预过滤 →
 * 只读时间窗内的 manifest.json 组装摘要；30s 结果缓存 + 异步并发扫描 + 候选/manifest 上限。
 */

/** 扫描并发上限：避免无界并发同时打爆磁盘与事件循环。 */
const SCAN_CONCURRENCY = 32;
/** 单次请求 manifest 读取硬上限：超限返回候选截断标记，不拖死接口。 */
const MANIFEST_READ_CAP = 2000;
/** 管理端候选会话上限（DB 侧 LIMIT）。 */
const ADMIN_CANDIDATE_CAP = 5000;
/** 结果缓存：30s TTL，LRU 上限 50 条（key 含作用域/筛选/分页）。 */
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 50;
/** 列表 size 上限（两端路由同一口径）。 */
const MAX_PAGE_SIZE = 200;

export interface BrowserReplayListFilters {
  userId?: number | null;
  agentId?: number | null;
  sessionId?: number | null;
  keyword?: string | null;
  range?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface BrowserReplayCatalogDeps {
  runtimeResolver: RuntimeDataResolver;
  replayService: BrowserReplayService;
  sessionService: { getSessionsByIds(ids: number[]): Promise<Session[]> };
  sessionRepository: Pick<SessionRepository, 'selectReplayCandidateSessions'>;
  userLookup?: { findByIds(ids: number[]): Promise<UserRef[]> };
  agentLookup?: { findByIds(ids: number[]): Promise<AgentRef[]> };
  /** 单次请求 manifest 读取硬上限（默认 2000；测试可调小）。 */
  manifestReadCap?: number;
}

interface ScanCandidate {
  userId: number;
  sessionId: number;
}

interface ScannedLive {
  userId: number;
  sessionId: number;
  manifest: ReplayManifest;
}

/** 读取列表 query（owner / admin 同一口径）：range/dateFrom/dateTo 走 resolveActivityWindow 解析。 */
export function parseReplayListQuery(
  request: FastifyRequest,
  defaultRange: string,
): { filters: BrowserReplayListFilters; page: number; size: number; refresh: boolean } {
  const range = queryOptStr(request, 'range');
  const dateFrom = queryOptStr(request, 'dateFrom');
  const dateTo = queryOptStr(request, 'dateTo');
  return {
    filters: {
      userId: queryOptInt(request, 'userId'),
      agentId: queryOptInt(request, 'agentId'),
      sessionId: queryOptInt(request, 'sessionId'),
      keyword: queryOptStr(request, 'keyword'),
      range,
      dateFrom,
      dateTo,
      // 三者全缺时才落默认档：显式 dateFrom/dateTo 优先（与 resolveActivityWindow 同口径）
      ...(range == null && dateFrom == null && dateTo == null ? { range: defaultRange } : {}),
    },
    page: queryInt(request, 'page', 1),
    size: Math.min(queryInt(request, 'size', 20), MAX_PAGE_SIZE),
    refresh: queryOptBool(request, 'refresh') ?? false,
  };
}

export class BrowserReplayCatalogService {
  private readonly cache = new Map<string, { result: BrowserReplayListResult; expiresAt: number }>();
  private readonly manifestReadCap: number;

  constructor(private readonly deps: BrowserReplayCatalogDeps) {
    this.manifestReadCap = deps.manifestReadCap ?? MANIFEST_READ_CAP;
  }

  /** 本人跨会话列表：只扫本人 runtime 目录（服务端只可能有 CLOUD 录制，LOCAL 录写在用户设备上）。 */
  async listForUser(
    userId: number,
    filters: BrowserReplayListFilters,
    page: number,
    size: number,
    refresh = false,
  ): Promise<BrowserReplayListResult> {
    return this.list('user', userId, filters, page, size, refresh);
  }

  /** 管理端全局列表：DB 候选会话（CLOUD）+ 批量补 username / agentName。 */
  async listForAdmin(
    filters: BrowserReplayListFilters,
    page: number,
    size: number,
    refresh = false,
  ): Promise<BrowserReplayListResult> {
    return this.list('admin', null, filters, page, size, refresh);
  }

  private async list(
    scope: 'user' | 'admin',
    scopeUserId: number | null,
    filters: BrowserReplayListFilters,
    page: number,
    size: number,
    refresh: boolean,
  ): Promise<BrowserReplayListResult> {
    const cacheKey = JSON.stringify({ scope, scopeUserId, filters, page, size });
    if (!refresh) {
      const cached = this.cacheGet(cacheKey);
      if (cached != null) return cached;
    }
    const result = await this.scanAndBuild(scope, scopeUserId, filters, page, size);
    if (!refresh) this.cacheSet(cacheKey, result);
    return result;
  }

  private async scanAndBuild(
    scope: 'user' | 'admin',
    scopeUserId: number | null,
    filters: BrowserReplayListFilters,
    page: number,
    size: number,
  ): Promise<BrowserReplayListResult> {
    const activityWindow = resolveActivityWindow({
      range: filters.range,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    });
    const { fromMs, toExclusiveMs } = windowToMs(activityWindow);

    const { candidates, truncatedCandidates } = await this.loadCandidates(scope, scopeUserId, filters, activityWindow);
    const scanned = await this.scanCandidates(candidates, fromMs, toExclusiveMs);
    return this.buildResult(scope, scopeUserId, scanned, page, size, truncatedCandidates || scanned.truncated);
  }

  /** 候选会话：admin 走 DB（时间窗超集，按活跃度倒序封顶）；owner 直接读本人 runtime 目录。 */
  private async loadCandidates(
    scope: 'user' | 'admin',
    scopeUserId: number | null,
    filters: BrowserReplayListFilters,
    activityWindow: ActivityWindow | null,
  ): Promise<{ candidates: ScanCandidate[]; truncatedCandidates: boolean }> {
    if (scope === 'admin') {
      const rows = await this.deps.sessionRepository.selectReplayCandidateSessions(
        {
          userId: filters.userId,
          agentId: filters.agentId,
          sessionId: filters.sessionId,
          keyword: filters.keyword,
          activityFrom: activityWindow?.from ?? null,
          activityToExclusive: activityWindow?.toExclusive ?? null,
        },
        ADMIN_CANDIDATE_CAP,
      );
      return {
        candidates: rows.map((row) => ({ userId: row.userId, sessionId: row.id })),
        truncatedCandidates: rows.length >= ADMIN_CANDIDATE_CAP,
      };
    }
    const userRoot = this.deps.runtimeResolver.resolveUserRuntimeDir(scopeUserId!);
    let names: string[];
    try {
      names = await readdir(userRoot);
    } catch {
      return { candidates: [], truncatedCandidates: false }; // 从未产生过 runtime
    }
    const candidates = names
      .filter((name) => /^\d+$/.test(name))
      .map((name) => ({ userId: scopeUserId!, sessionId: Number(name) }));
    return { candidates, truncatedCandidates: false };
  }

  /** 并发扫描：每个候选会话 readdir 回放根 → liveId 时间戳预过滤 → 读 manifest（预算制）。 */
  private async scanCandidates(
    candidates: ScanCandidate[],
    fromMs: number | null,
    toExclusiveMs: number | null,
  ): Promise<{ lives: ScannedLive[]; truncated: boolean }> {
    const budget = { reads: 0, truncated: false };
    const lives: ScannedLive[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(SCAN_CONCURRENCY, Math.max(candidates.length, 1)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const candidate = candidates[index]!;
        for (const manifest of await this.scanSession(candidate, fromMs, toExclusiveMs, budget)) {
          lives.push({ ...candidate, manifest });
        }
      }
    });
    await Promise.all(workers);
    lives.sort((a, b) => {
      const diff = b.manifest.startedAt - a.manifest.startedAt;
      return diff !== 0 ? diff : Number(b.manifest.liveId.slice(1)) - Number(a.manifest.liveId.slice(1));
    });
    return { lives, truncated: budget.truncated };
  }

  private async scanSession(
    candidate: ScanCandidate,
    fromMs: number | null,
    toExclusiveMs: number | null,
    budget: { reads: number; truncated: boolean },
  ): Promise<ReplayManifest[]> {
    const root = this.deps.replayService.replayRootFor(candidate.userId, candidate.sessionId);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return []; // 无 replay 目录 = 该会话从未录制
    }
    const manifests: ReplayManifest[] = [];
    for (const name of names) {
      if (!LIVE_ID_PATTERN.test(name)) continue;
      // liveId = L<startedAt 毫秒>：时间窗外的目录不读 manifest（扫描收敛的关键）
      const liveTs = Number(name.slice(1));
      if (!Number.isSafeInteger(liveTs)) continue;
      if (fromMs != null && liveTs < fromMs) continue;
      if (toExclusiveMs != null && liveTs >= toExclusiveMs) continue;
      if (budget.reads >= this.manifestReadCap) {
        budget.truncated = true;
        break;
      }
      budget.reads += 1;
      const liveDir = this.deps.replayService.resolveLiveDir(root, name);
      if (liveDir == null) continue;
      let raw: string;
      try {
        raw = await readFile(path.join(liveDir, 'manifest.json'), 'utf8');
      } catch {
        continue; // 场次目录损坏/正在写入：按不存在跳过
      }
      const manifest = parseReplayManifest(raw, name);
      if (manifest == null) continue;
      // 目录名时间戳只是预过滤，manifest.startedAt 再精确校验一次（liveId 碰撞会顺延 +1ms）
      if (fromMs != null && manifest.startedAt < fromMs) continue;
      if (toExclusiveMs != null && manifest.startedAt >= toExclusiveMs) continue;
      manifests.push(manifest);
    }
    return manifests;
  }

  /** 分页 + 批量补元数据：先按全部命中会话过滤孤儿（已删除/清理残留）再分页，保证 total 与记录一致；Agent/用户只对当前页补。 */
  private async buildResult(
    scope: 'user' | 'admin',
    scopeUserId: number | null,
    scanned: { lives: ScannedLive[]; truncated: boolean },
    page: number,
    size: number,
    truncatedCandidates: boolean,
  ): Promise<BrowserReplayListResult> {
    const safePage = Math.max(1, page);
    const safeSize = Math.min(Math.max(1, size), MAX_PAGE_SIZE);

    const sessionIds = [...new Set(scanned.lives.map((live) => live.sessionId))];
    const sessions = await this.deps.sessionService.getSessionsByIds(sessionIds);
    const sessionById = new Map<number, Session>();
    for (const session of sessions) {
      if (session.id != null) sessionById.set(session.id, session);
    }
    // 孤儿会话（软删后清理残留 / 读取后竞态删除）不占列表位：先过滤再分页。
    // owner 视图还须按 user_id 收敛：runtime 目录按「发言者运行身份」落盘，群聊会话的录制
    // 会落在发言者目录下，不收敛会把他人会话的标题/Agent/pageUrl 泄给非归属者（方案 §7 越权枚举）。
    const keptLives = scanned.lives.filter((live) => {
      const session = sessionById.get(live.sessionId);
      if (session == null) return false;
      return scope !== 'user' || session.userId === scopeUserId;
    });

    const total = keptLives.length;
    const pageLives = keptLives.slice((safePage - 1) * safeSize, safePage * safeSize);
    const base = { total, page: safePage, size: safeSize, ...(truncatedCandidates ? { truncatedCandidates: true } : {}) };
    if (pageLives.length === 0) {
      return { records: [], ...base };
    }

    const agentNames = await this.loadAgentNames(pageLives, sessionById);
    const usernames = scope === 'admin' ? await this.loadUsernames(pageLives, sessionById) : new Map<number, string>();

    const records: BrowserReplayListItem[] = pageLives.map((live) => {
      const session = sessionById.get(live.sessionId)!;
      const agentId = session.agentId ?? null;
      return {
        sessionId: live.sessionId,
        liveId: live.manifest.liveId,
        executionMode: 'CLOUD',
        sessionTitle: session.title ?? null,
        agentId,
        agentName: agentId != null ? agentNames.get(agentId) ?? null : null,
        ...(scope === 'admin'
          ? { userId: session.userId, username: usernames.get(session.userId) ?? undefined }
          : {}),
        startedAt: live.manifest.startedAt,
        endedAt: live.manifest.endedAt ?? null,
        durationMs: live.manifest.durationMs ?? null,
        frameCount: live.manifest.frameCount ?? 0,
        approxBytes: live.manifest.approxBytes ?? 0,
        truncated: live.manifest.truncated === true,
        pageUrl: live.manifest.urls?.[0] ?? '',
      };
    });
    return { records, ...base };
  }

  private async loadAgentNames(
    lives: ScannedLive[],
    sessionById: Map<number, Session>,
  ): Promise<Map<number, string>> {
    if (this.deps.agentLookup == null) return new Map();
    const agentIds = collectEntityIds(
      lives.map((live) => sessionById.get(live.sessionId)?.agentId),
    );
    if (agentIds.length === 0) return new Map();
    const agents = await this.deps.agentLookup.findByIds(agentIds);
    return new Map(agents.map((agent) => [agent.id, agent.name]));
  }

  private async loadUsernames(
    lives: ScannedLive[],
    sessionById: Map<number, Session>,
  ): Promise<Map<number, string>> {
    if (this.deps.userLookup == null) return new Map();
    const userIds = collectEntityIds(lives.map((live) => sessionById.get(live.sessionId)?.userId));
    if (userIds.length === 0) return new Map();
    const users = await this.deps.userLookup.findByIds(userIds);
    return new Map(users.map((user) => [user.id, user.username]));
  }

  private cacheGet(key: string): BrowserReplayListResult | null {
    const hit = this.cache.get(key);
    if (hit == null) return null;
    if (hit.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return null;
    }
    // LRU：命中后移到队尾
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.result;
  }

  private cacheSet(key: string, result: BrowserReplayListResult): void {
    this.cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    while (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

/**
 * 活跃时间窗（'YYYY-MM-DD HH:MM:SS'，Asia/Shanghai 墙钟）→ epoch ms 半开区间。
 * 进程时区由 config/process-timezone.ts 在入口固定为 Asia/Shanghai，按本地解析即墙钟口径；
 * manifest.startedAt / liveId 时间戳都是 epoch ms，直接可比。
 */
function windowToMs(window: ActivityWindow | null): { fromMs: number | null; toExclusiveMs: number | null } {
  if (window == null) return { fromMs: null, toExclusiveMs: null };
  return {
    fromMs: window.from != null ? wallClockToMs(window.from) : null,
    toExclusiveMs: window.toExclusive != null ? wallClockToMs(window.toExclusive) : null,
  };
}

function wallClockToMs(value: string): number {
  const ms = new Date(value.replace(' ', 'T')).getTime();
  if (Number.isNaN(ms)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '时间范围不合法');
  }
  return ms;
}
