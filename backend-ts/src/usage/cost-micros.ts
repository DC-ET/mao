/**
 * 成本计价口径（技术方案 §5.2）：
 *
 *   prompt_billable = max(0, prompt_tokens − cached_tokens × 0.5)   缓存命中按 5 折计价；下限钳制防
 *                                                                    cached > prompt 的异常供应商产生负成本
 *   cost_micros     = round(prompt_billable × price_input + completion_tokens × price_output)
 *
 * cost_micros = 成本单位 × 10⁶ 的整数（DECIMAL 价格按"每百万 token"填写），聚合 SUM 与比较全在整数域，
 * 避免浮点累加误差。tokens × price 整数域最大约 2×10¹⁵（< 2⁵³），JS Number 精度安全。
 * 前提假设：cached_tokens ⊆ prompt_tokens（OpenAI / Anthropic 主流口径）；不符的供应商按"含缓存折算价"填写。
 */
export interface CostPrice {
  /** 每百万输入 token 价格（成本单位）；null = 不计成本 */
  priceInput: number | null;
  /** 每百万输出 token 价格（成本单位）；null = 不计成本 */
  priceOutput: number | null;
}

export interface CostUsageInput {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** 任一价格为 NULL → 成本 NULL（本地模型 / 未填价模型不计成本，聚合 SUM 自动忽略 NULL 行）。 */
export function computeCostMicros(price: CostPrice | null | undefined, usage: CostUsageInput): number | null {
  if (price == null || price.priceInput == null || price.priceOutput == null) {
    return null;
  }
  const cached = Number(usage.cachedTokens) || 0;
  const prompt = Number(usage.promptTokens) || 0;
  const completion = Number(usage.completionTokens) || 0;
  const promptBillable = Math.max(0, prompt - cached * 0.5);
  const micros = promptBillable * price.priceInput + completion * price.priceOutput;
  // Math.round 已可覆盖 < 2⁵³ 的整数域；负值不可能出现（promptBillable 钳制 + 价格非负校验）
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
 * 价格字段缺失（undefined，旧调用路径遗漏）时返回 undefined，由 LlmCallService 走兜底价格缓存；
 * 显式 null（模型未配价）直接产出 NULL 成本，不再回查。
 */
export function snapshotCostMicros(
  config: { priceInput?: number | null; priceOutput?: number | null },
  usage: { promptTokens?: number | null; promptTokensDetails?: { cachedTokens?: number | null } | null; completionTokens?: number | null } | null | undefined,
): number | null | undefined {
  if (config.priceInput === undefined && config.priceOutput === undefined) {
    return undefined;
  }
  return computeCostMicros(
    { priceInput: config.priceInput ?? null, priceOutput: config.priceOutput ?? null },
    {
      promptTokens: usage?.promptTokens ?? 0,
      cachedTokens: usage?.promptTokensDetails?.cachedTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
    },
  );
}
