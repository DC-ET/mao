import type { ChatUsage } from '../harness/llm/chat-request.js';
import { LlmCallContext } from './llm-call-context.js';
import { computeCostMicros, parsePriceColumn, type CostPrice } from './cost-micros.js';
import type { LlmCallListFilter, LlmCallRepository, LlmCallRow } from './llm-call.repository.js';

export interface LlmCallModelConfig {
  id?: number;
  name?: string | null;
  provider?: string | null;
  apiProtocol?: string | null;
  effort?: string | null;
  modelId?: string;
  /** 成本快照主路径：价格随模型解析链下发。缺失（undefined）时走兜底价格缓存（技术方案 §5.3）。 */
  priceInput?: number | null;
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

/** 模型价格兜底查询：返回模型行价格（原始 DECIMAL 值）；模型不存在/已删返回 null。 */
export type ModelPriceLookup = (id: number) => Promise<{ priceInput?: unknown; priceOutput?: unknown } | null>;

interface CacheEntry {
  price: CostPrice | null;
  expiresAt: number;
}

const PRICE_CACHE_TTL_MS = 60_000;

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
    let costMicros = input.costMicros;
    if (costMicros === undefined) {
      costMicros = await this.resolveCostMicros(input, usage, cached);
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
  ): Promise<number | null> {
    const price = await this.lookupPrice(input.modelConfig.id);
    if (price == null) return null;
    return computeCostMicros(price, {
      promptTokens: usage?.promptTokens ?? 0,
      cachedTokens,
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
        price = { priceInput: parsePriceColumn(row.priceInput), priceOutput: parsePriceColumn(row.priceOutput) };
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
