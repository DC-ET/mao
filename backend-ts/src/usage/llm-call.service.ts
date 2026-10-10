import type { ChatUsage } from '../harness/llm/chat-request.js';
import { addDaysYmd, formatDateTime, shanghaiYmd } from '../common/json.js';
import { LlmCallContext } from './llm-call-context.js';
import { computeCostMicros, parsePriceColumn, type CostPrice } from './cost-micros.js';
import type {
  LlmCallAggFilter,
  LlmCallAgentAggRow,
  LlmCallListFilter,
  LlmCallModelAggRow,
  LlmCallRepository,
  LlmCallRow,
  LlmCallSceneAggRow,
  LlmCallSummaryRow,
  LlmCallTrendRow,
  TrendGranularity,
} from './llm-call.repository.js';

export interface LlmCallModelConfig {
  id?: number;
  name?: string | null;
  provider?: string | null;
  apiProtocol?: string | null;
  effort?: string | null;
  modelId?: string;
  /** 成本快照主路径：价格随模型解析链下发。缺失（undefined）时走兜底价格缓存（技术方案 §5.3）。 */
  priceInput?: number | null;
  priceCacheRead?: number | null;
  priceCacheWrite?: number | null;
  priceOutput?: number | null;
}

export interface LlmCallRecordInput {
  modelConfig: LlmCallModelConfig;
  stream: boolean;
  usage?: ChatUsage | null;
  success: boolean;
  errorMessage?: string | null;
  firstTokenMs?: number | null;
  durationMs: number;
  retryCount?: number;
  /** 调用方已按配置快照算好的成本（主路径）。undefined = 未计算，走兜底价格缓存。 */
  costMicros?: number | null;
}

export interface LlmCallListItem extends LlmCallRow {
  username?: string | null;
  displayName?: string | null;
  agentName?: string | null;
}

/** 模型价格兜底查询：返回模型行四项价格（原始 DECIMAL 值）；模型不存在/已删返回 null。 */
export type ModelPriceLookup = (id: number) => Promise<{
  priceInput?: unknown;
  priceCacheRead?: unknown;
  priceCacheWrite?: unknown;
  priceOutput?: unknown;
} | null>;

/** 用户端统计周期：今日 / 昨日 / 本周 / 本月 + 近 7 / 30 天滚动窗口（均为 Asia/Shanghai 日历口径）。 */
export type UsageRange = 'today' | 'yesterday' | 'week' | 'month' | 'last7' | 'last30';

const USAGE_RANGES: UsageRange[] = ['today', 'yesterday', 'week', 'month', 'last7', 'last30'];

/** 用户端汇总默认周期。 */
const USAGE_RANGE_DEFAULT: UsageRange = 'last30';

/** range 入参白名单校验：非法/缺省回落默认周期（路由已解析，这里兜底防直接调用）。 */
export function parseUsageRange(value: string | undefined): UsageRange {
  return USAGE_RANGES.includes(value as UsageRange) ? (value as UsageRange) : USAGE_RANGE_DEFAULT;
}

/** 用户端用量总览：窗口总账 + 按模型 + 按场景 + 按 Agent（一次请求给全，前端同周期展示）。 */
export interface MyUsageSummary {
  range: UsageRange;
  totals: LlmCallSummaryRow;
  byModel: LlmCallModelAggRow[];
  byScene: LlmCallSceneAggRow[];
  byAgent: LlmCallAgentAggRow[];
}

/** 用户端用量趋势：按天/小时分桶的连续序列（后端补零，无缺口）。 */
export interface MyUsageTrends {
  range: UsageRange;
  granularity: TrendGranularity;
  buckets: LlmCallTrendRow[];
}

interface CacheEntry {
  price: CostPrice | null;
  expiresAt: number;
}

const PRICE_CACHE_TTL_MS = 60_000;

/** 本周一（周一为一周起点）。 */
function weekStartYmd(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDaysYmd(today, dow === 0 ? -6 : 1 - dow);
}

/** 周期 → 闭区间窗口（含首尾全天，时区口径同管理后台：Asia/Shanghai 日历日）。 */
function rangeWindow(range: UsageRange): LlmCallAggFilter & { startYmd: string; endYmd: string } {
  const today = shanghaiYmd();
  let startYmd: string;
  let endYmd = today;
  switch (range) {
    case 'today':
      startYmd = today;
      break;
    case 'yesterday':
      startYmd = endYmd = addDaysYmd(today, -1);
      break;
    case 'week':
      startYmd = weekStartYmd(today);
      break;
    case 'month':
      startYmd = `${today.slice(0, 7)}-01`;
      break;
    case 'last7':
      startYmd = addDaysYmd(today, -6);
      break;
    default:
      startYmd = addDaysYmd(today, -29);
      break;
  }
  return {
    startAt: `${startYmd} 00:00:00`,
    endAt: `${endYmd} 23:59:59`,
    startYmd,
    endYmd,
  };
}

function addHoursKey(key: string, hours: number): string {
  const [date, time] = key.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const hh = Number(time.slice(0, 2));
  const dt = new Date(Date.UTC(y, m - 1, d, hh + hours));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:00`;
}

/**
 * 趋势桶键序列（口径同管理后台 admin-analytics）：day 为 startYmd..endYmd 连续日历日；
 * hour 为整点键——窗口含今天时不超过当前整点（今天未发生的整点不出现在图上），
 * 窗口已结束（如昨日）则补满全天。
 */
function buildTrendKeys(startYmd: string, endYmd: string, granularity: TrendGranularity): string[] {
  const dayCount = ymdDiffDays(startYmd, endYmd) + 1;
  if (granularity !== 'hour') {
    const keys: string[] = [];
    for (let i = 0; i < dayCount; i++) keys.push(addDaysYmd(startYmd, i));
    return keys;
  }
  const keys: string[] = [];
  const endExclusive = `${addDaysYmd(endYmd, 1)} 00:00`;
  const nowKey = `${formatDateTime(new Date()).slice(0, 13)}:00`;
  const capAtNow = endYmd >= shanghaiYmd();
  let cursor = `${startYmd} 00:00`;
  for (let i = 0; i < dayCount * 24 && cursor < endExclusive; i++) {
    if (capAtNow && cursor > nowKey) break;
    keys.push(cursor);
    cursor = addHoursKey(cursor, 1);
  }
  return keys.length > 0 ? keys : [`${startYmd} 00:00`];
}

/** 两个 YYYY-MM-DD 之间的日历天数差（to - from）。 */
function ymdDiffDays(from: string, to: string): number {
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

const ZERO_TREND_BUCKET = { callCount: 0, failCount: 0, promptTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0 } as const;

/** 聚合行按桶键回填到完整序列：缺失桶补零，前端无需再做日期运算（也无浏览器时区错位风险）。 */
function fillTrendBuckets(rows: LlmCallTrendRow[], keys: string[]): LlmCallTrendRow[] {
  const byKey = new Map(rows.map((r) => [r.bucket, r]));
  // 有数据的行也过一遍零值基准，保证每桶字段齐全（趋势图按固定字段读）
  return keys.map((key) => ({ ...ZERO_TREND_BUCKET, ...byKey.get(key), bucket: key }));
}

export class LlmCallService {
  /** 60s TTL 内存缓存（含"模型不存在"负缓存）：覆盖价格未随配置下发的兜底路径。 */
  private priceCache = new Map<number, CacheEntry>();

  constructor(
    private readonly repo: LlmCallRepository,
    private readonly userLookup?: { findUsername(id: number): Promise<{ username?: string | null; displayName?: string | null } | null> },
    private readonly agentLookup?: { findName(id: number): Promise<string | null> },
    private readonly modelPriceLookup?: ModelPriceLookup | null,
  ) {}

  async record(input: LlmCallRecordInput): Promise<void> {
    const ctx = LlmCallContext.get();
    const usage = input.usage;
    const cached = usage?.promptTokensDetails?.cachedTokens ?? 0;
    const cacheCreation = usage?.promptTokensDetails?.cacheCreationTokens ?? 0;
    let costMicros = input.costMicros;
    if (costMicros === undefined) {
      costMicros = await this.resolveCostMicros(input, usage, cached, cacheCreation);
    }
    try {
      await this.repo.insert({
        userId: ctx?.userId ?? null,
        sessionId: ctx?.sessionId ?? null,
        agentId: ctx?.agentId ?? null,
        modelId: input.modelConfig.id ?? null,
        modelName: input.modelConfig.name ?? null,
        provider: input.modelConfig.provider ?? null,
        providerModelId: input.modelConfig.modelId ?? null,
        scene: ctx?.scene ?? 'unknown',
        stream: input.stream ? 1 : 0,
        effort: input.modelConfig.effort ?? null,
        protocol: input.modelConfig.apiProtocol ?? null,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cachedTokens: cached ?? 0,
        cacheCreationTokens: cacheCreation ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        costMicros: costMicros ?? null,
        success: input.success ? 1 : 0,
        errorMessage: truncateError(input.errorMessage),
        firstTokenMs: input.firstTokenMs ?? null,
        durationMs: input.durationMs,
        retryCount: input.retryCount ?? 0,
      });
    } catch (e) {
      console.warn(`[llm-call] failed to persist call record: ${(e as Error).message}`);
    }
  }

  /**
   * 兜底成本解析（技术方案 §5.3）：价格未随 LlmModelConfig 下发时按 modelId 查模型价格缓存，
   * 仍取不到（未注入 lookup / 模型不存在或已软删）→ NULL。改价后 TTL 内用旧价，可接受。
   */
  private async resolveCostMicros(
    input: LlmCallRecordInput,
    usage: ChatUsage | null | undefined,
    cachedTokens: number,
    cacheCreationTokens: number,
  ): Promise<number | null> {
    const price = await this.lookupPrice(input.modelConfig.id);
    if (price == null) return null;
    return computeCostMicros(price, {
      promptTokens: usage?.promptTokens ?? 0,
      cachedTokens,
      cacheCreationTokens,
      completionTokens: usage?.completionTokens ?? 0,
    });
  }

  private async lookupPrice(modelId: number | undefined): Promise<CostPrice | null> {
    if (modelId == null || this.modelPriceLookup == null) return null;
    const now = Date.now();
    const hit = this.priceCache.get(modelId);
    if (hit != null && hit.expiresAt > now) {
      return hit.price;
    }
    let price: CostPrice | null = null;
    try {
      const row = await this.modelPriceLookup(modelId);
      if (row != null) {
        price = {
          priceInput: parsePriceColumn(row.priceInput),
          priceCacheRead: parsePriceColumn(row.priceCacheRead),
          priceCacheWrite: parsePriceColumn(row.priceCacheWrite),
          priceOutput: parsePriceColumn(row.priceOutput),
        };
      }
    } catch (e) {
      console.warn(`[llm-call] model price lookup failed for model ${modelId}: ${(e as Error).message}`);
    }
    this.priceCache.set(modelId, { price, expiresAt: now + PRICE_CACHE_TTL_MS });
    return price;
  }

  async listForAdmin(
    page: number,
    size: number,
    filter: LlmCallListFilter,
  ): Promise<{ records: LlmCallListItem[]; total: number; page: number; size: number }> {
    const clampedSize = Math.min(Math.max(size, 1), 100);
    const result = await this.repo.list(Math.max(page, 1), clampedSize, filter);
    const records = await this.enrichRecords(result.records);
    return { records, total: result.total, page: Math.max(page, 1), size: clampedSize };
  }

  async listForUser(
    userId: number,
    page: number,
    size: number,
    filter: Omit<LlmCallListFilter, 'userId'>,
  ): Promise<{ records: LlmCallListItem[]; total: number; page: number; size: number }> {
    return this.listForAdmin(page, size, { ...filter, userId });
  }

  /** 当前用户指定周期用量总览（总账 + 按模型 + 按场景 + 按 Agent，一次返回）。 */
  async summaryForUser(userId: number, range?: UsageRange): Promise<MyUsageSummary> {
    const resolved = parseUsageRange(range);
    const window = rangeWindow(resolved);
    const [totals, byModel, byScene, byAgent] = await Promise.all([
      this.repo.aggregateSummary(userId, window),
      this.repo.aggregateByModel(userId, window),
      this.repo.aggregateByScene(userId, window),
      this.repo.aggregateByAgent(userId, window),
    ]);
    return { range: resolved, totals, byModel, byScene, byAgent: await this.resolveAgentNames(byAgent) };
  }

  /** 按 Agent 汇总补名字：agent_id 为 null（压缩/标题等无归属调用）或已删 Agent 时名字为 null，前端兜底展示。 */
  private async resolveAgentNames(rows: LlmCallAgentAggRow[]): Promise<LlmCallAgentAggRow[]> {
    const ids = [...new Set(rows.map((r) => r.agentId).filter((id): id is number => id != null))];
    if (ids.length === 0 || !this.agentLookup) return rows;
    const names = await Promise.all(ids.map(async (id) => {
      try {
        return [id, await this.agentLookup!.findName(id)] as const;
      } catch (e) {
        console.warn(`[llm-call] agent name lookup failed for agent ${id}: ${(e as Error).message}`);
        return [id, null] as const;
      }
    }));
    const nameMap = new Map(names);
    return rows.map((row) => ({ ...row, agentName: nameMap.get(row.agentId ?? -1) ?? null }));
  }

  /** 当前用户指定周期用量趋势（按天/小时分桶；后端补零，序列连续无缺口）。 */
  async trendsForUser(userId: number, range?: UsageRange, granularity: TrendGranularity = 'day'): Promise<MyUsageTrends> {
    const resolved = parseUsageRange(range);
    const window = rangeWindow(resolved);
    const rows = await this.repo.aggregateTrend(userId, window, granularity);
    const keys = buildTrendKeys(window.startYmd, window.endYmd, granularity);
    return { range: resolved, granularity, buckets: fillTrendBuckets(rows, keys) };
  }

  private async enrichRecords(records: LlmCallRow[]): Promise<LlmCallListItem[]> {
    const userIds = [...new Set(records.map((r) => r.userId).filter((id): id is number => id != null))];
    const agentIds = [...new Set(records.map((r) => r.agentId).filter((id): id is number => id != null))];
    const userMap = new Map<number, { username?: string | null; displayName?: string | null }>();
    const agentMap = new Map<number, string>();
    if (this.userLookup) {
      await Promise.all(userIds.map(async (id) => {
        const user = await this.userLookup!.findUsername(id);
        if (user) userMap.set(id, user);
      }));
    }
    if (this.agentLookup) {
      await Promise.all(agentIds.map(async (id) => {
        const name = await this.agentLookup!.findName(id);
        if (name) agentMap.set(id, name);
      }));
    }
    return records.map((row) => ({
      ...row,
      username: row.userId != null ? userMap.get(row.userId)?.username ?? null : null,
      displayName: row.userId != null ? userMap.get(row.userId)?.displayName ?? null : null,
      agentName: row.agentId != null ? agentMap.get(row.agentId) ?? null : null,
    }));
  }
}

function truncateError(message: string | null | undefined): string | null {
  if (message == null || message.trim() === '') return null;
  const trimmed = message.trim();
  return trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
}
