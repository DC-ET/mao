/**
 * 成本计价口径（技术方案 §5.2）——价格四项化，逐项相加：
 *
 *   price_input        每百万「非缓存」输入 token 价格（OpenAI: prompt − cached；Anthropic: input_tokens）
 *   price_cache_read   每百万缓存命中输入 token 价格（OpenAI: cached；Anthropic: cache_read）
 *   price_cache_write  每百万缓存写入输入 token 价格（Anthropic: cache_creation；OpenAI 系无此概念恒 0）
 *   price_output       每百万输出 token 价格
 *
 *   cost_micros = round(non_cached × pi + cache_read × pr + cache_write × pw + completion × po)
 *
 * cost_micros = 成本单位 × 10⁶ 的整数（DECIMAL 价格按"每百万 token"填写），聚合 SUM 与比较全在整数域，
 * 避免浮点累加误差。tokens × price 整数域最大约 2×10¹⁵（< 2⁵³），JS Number 精度安全。
 * 折率不再由系统拍定：各供应商差异极大（OpenAI 缓存读 50%、无缓存写；Anthropic 缓存读约 10%、
 * 缓存写约 125%），统一折率必然同时高估与低估，故由 price_cache_* 显式表达（决策 14）。
 */
export interface CostPrice {
  /** 每百万非缓存输入 token 价格（成本单位）；null = 该类 token 不计成本 */
  priceInput: number | null;
  /** 每百万缓存命中输入 token 价格（成本单位）；null = 该类 token 不计成本 */
  priceCacheRead: number | null;
  /** 每百万缓存写入输入 token 价格（成本单位）；null = 该类 token 不计成本 */
  priceCacheWrite: number | null;
  /** 每百万输出 token 价格（成本单位）；null = 该类 token 不计成本 */
  priceOutput: number | null;
}

export interface CostUsageInput {
  promptTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  completionTokens: number;
}

/**
 * 「产生了该类 token 但对应价格为空」→ 整行 NULL（决策 15）。
 * 低估的账目比没有账目更危险：它会直接骗过预算闸门，因此宁可整行不计成本。
 * 反向不成立——token 为 0 时对应价格即使是 NULL 也不影响计算（本地模型只填输入 / 输出即可）。
 * 入参须为已归一的 token 分项。
 */
function missingPriceForTokens(price: CostPrice, parts: { nonCached: number; cacheRead: number; cacheWrite: number; completion: number }): boolean {
  if (parts.cacheRead > 0 && price.priceCacheRead == null) return true;
  if (parts.cacheWrite > 0 && price.priceCacheWrite == null) return true;
  if (parts.nonCached > 0 && price.priceInput == null) return true;
  if (parts.completion > 0 && price.priceOutput == null) return true;
  return false;
}

/**
 * 归一 token 分项（非缓存输入 = 总输入 − 缓存读 − 缓存写），下限钳制防异常供应商
 * （cached > prompt 之类）产生负成本污染 SUM。
 */
function normalizeUsage(usage: CostUsageInput): { nonCached: number; cacheRead: number; cacheWrite: number; completion: number } {
  const num = (v: number | null | undefined): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const prompt = num(usage.promptTokens);
  const cacheRead = Math.min(num(usage.cachedTokens), prompt);
  const cacheWrite = Math.min(num(usage.cacheCreationTokens), Math.max(0, prompt - cacheRead));
  return {
    nonCached: Math.max(0, prompt - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    completion: num(usage.completionTokens),
  };
}

/** 计价：任一「产生了 token 却未配价」的类型 → NULL（未配价模型不计成本，聚合 SUM 自动忽略 NULL 行）。 */
export function computeCostMicros(price: CostPrice | null | undefined, usage: CostUsageInput): number | null {
  if (price == null) return null;
  const parts = normalizeUsage(usage);
  if (missingPriceForTokens(price, parts)) {
    return null;
  }
  const nz = (v: number | null): number => (v == null ? 0 : v);
  const micros = parts.nonCached * nz(price.priceInput)
    + parts.cacheRead * nz(price.priceCacheRead)
    + parts.cacheWrite * nz(price.priceCacheWrite)
    + parts.completion * nz(price.priceOutput);
  // Math.round 已可覆盖 < 2⁵³ 的整数域；负值不可能出现（token 非负钳制 + 价格非负校验）
  return Math.round(micros);
}

/** DECIMAL 列经 mysql2 读出为 string；解析为 number，空值/非法值归一为 null。 */
export function parsePriceColumn(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

/**
 * 成本快照主路径（技术方案 §5.3）：价格随模型配置下发时按配置快照即时计价。
 * 价格字段全缺失（undefined，旧调用路径遗漏）时返回 undefined，由 LlmCallService 走兜底价格缓存；
 * 已下发（含显式 null）直接出结论，不再回查。
 */
export function snapshotCostMicros(
  config: {
    priceInput?: number | null;
    priceCacheRead?: number | null;
    priceCacheWrite?: number | null;
    priceOutput?: number | null;
  },
  usage: {
    promptTokens?: number | null;
    promptTokensDetails?: { cachedTokens?: number | null; cacheCreationTokens?: number | null } | null;
    completionTokens?: number | null;
  } | null | undefined,
): number | null | undefined {
  if (
    config.priceInput === undefined
    && config.priceCacheRead === undefined
    && config.priceCacheWrite === undefined
    && config.priceOutput === undefined
  ) {
    return undefined;
  }
  return computeCostMicros(
    {
      priceInput: config.priceInput ?? null,
      priceCacheRead: config.priceCacheRead ?? null,
      priceCacheWrite: config.priceCacheWrite ?? null,
      priceOutput: config.priceOutput ?? null,
    },
    {
      promptTokens: usage?.promptTokens ?? 0,
      cachedTokens: usage?.promptTokensDetails?.cachedTokens ?? 0,
      cacheCreationTokens: usage?.promptTokensDetails?.cacheCreationTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    },
  );
}
