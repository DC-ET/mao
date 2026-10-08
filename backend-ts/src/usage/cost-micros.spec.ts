import { describe, expect, it } from 'vitest';
import { computeCostMicros, parsePriceColumn, snapshotCostMicros } from './cost-micros.js';

describe('computeCostMicros', () => {
  it('锚点用例（技术方案 §7）：prompt=1000 / cached=400 / completion=200 / 输入2 / 输出8 → 3200', () => {
    // prompt_billable = 1000 − 400×0.5 = 800；800×2 + 200×8 = 3200
    expect(computeCostMicros(
      { priceInput: 2, priceOutput: 8 },
      { promptTokens: 1000, cachedTokens: 400, completionTokens: 200 },
    )).toBe(3200);
  });

  it('缓存命中按 5 折计价：无缓存时全额计输入', () => {
    expect(computeCostMicros(
      { priceInput: 1.5, priceOutput: 3 },
      { promptTokens: 1000, cachedTokens: 0, completionTokens: 100 },
    )).toBe(1800); // 1000×1.5 + 100×3
  });

  it('任一价格为 NULL → 成本 NULL（不计成本）', () => {
    const usage = { promptTokens: 10, cachedTokens: 0, completionTokens: 10 };
    expect(computeCostMicros({ priceInput: null, priceOutput: 8 }, usage)).toBeNull();
    expect(computeCostMicros({ priceInput: 2, priceOutput: null }, usage)).toBeNull();
    expect(computeCostMicros({ priceInput: null, priceOutput: null }, usage)).toBeNull();
    expect(computeCostMicros(null, usage)).toBeNull();
    expect(computeCostMicros(undefined, usage)).toBeNull();
  });

  it('价格 0 是合法免费模型：成本为 0 而非 NULL', () => {
    expect(computeCostMicros(
      { priceInput: 0, priceOutput: 0 },
      { promptTokens: 100, cachedTokens: 0, completionTokens: 100 },
    )).toBe(0);
  });

  it('token 全 0 → 成本 0', () => {
    expect(computeCostMicros(
      { priceInput: 2, priceOutput: 8 },
      { promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
    )).toBe(0);
  });

  it('cached > prompt 时钳制为 0，不产生负成本', () => {
    expect(computeCostMicros(
      { priceInput: 2, priceOutput: 8 },
      { promptTokens: 100, cachedTokens: 500, completionTokens: 0 },
    )).toBe(0);
    expect(computeCostMicros(
      { priceInput: 2, priceOutput: 8 },
      { promptTokens: 100, cachedTokens: 500, completionTokens: 50 },
    )).toBe(400);
  });

  it('非数字 token 归一为 0', () => {
    expect(computeCostMicros(
      { priceInput: 2, priceOutput: 8 },
      { promptTokens: NaN, cachedTokens: undefined as unknown as number, completionTokens: null as unknown as number },
    )).toBe(0);
  });

  it('小数价格四舍五入到整数微单位', () => {
    // 3 × 0.333333 = 0.999999 → round → 1
    expect(computeCostMicros(
      { priceInput: 0, priceOutput: 0.333333 },
      { promptTokens: 0, cachedTokens: 0, completionTokens: 3 },
    )).toBe(1);
  });

  it('大数精度：2×10¹⁵ 微单位无漂移（< 2⁵³）', () => {
    const micros = computeCostMicros(
      { priceInput: 0, priceOutput: 1 },
      { promptTokens: 0, cachedTokens: 0, completionTokens: 2_000_000_000_000_000 },
    );
    expect(micros).toBe(2_000_000_000_000_000);
    expect(Number.isSafeInteger(micros)).toBe(true);
    // 手算锚点：billable = 1e11 − 4e10×0.5 = 8e10；8e10×12.345678 + 1e10×98.765432 = 1,975,308,560,000
    const mixed = computeCostMicros(
      { priceInput: 12.345678, priceOutput: 98.765432 },
      { promptTokens: 100_000_000_000, cachedTokens: 40_000_000_000, completionTokens: 10_000_000_000 },
    );
    expect(mixed).toBe(1_975_308_560_000);
    expect(Number.isSafeInteger(mixed)).toBe(true);
  });
});

describe('parsePriceColumn', () => {
  it('DECIMAL string 解析为 number', () => {
    expect(parsePriceColumn('2.5')).toBe(2.5);
    expect(parsePriceColumn('0.000001')).toBe(0.000001);
    expect(parsePriceColumn(3)).toBe(3);
  });

  it('空值/非法值归一为 null', () => {
    expect(parsePriceColumn(null)).toBeNull();
    expect(parsePriceColumn(undefined)).toBeNull();
    expect(parsePriceColumn('')).toBeNull();
    expect(parsePriceColumn('abc')).toBeNull();
    expect(parsePriceColumn(Infinity)).toBeNull();
  });
});

describe('snapshotCostMicros', () => {
  // 与 ChatUsage 口径一致：缓存 token 在 promptTokensDetails 内
  const usage = { promptTokens: 1000, promptTokensDetails: { cachedTokens: 400 }, completionTokens: 200 };

  it('价格随配置下发 → 写时快照计价', () => {
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, usage)).toBe(3200);
  });

  it('价格字段双缺失（undefined）→ undefined，交由 LlmCallService 走兜底缓存', () => {
    expect(snapshotCostMicros({}, usage)).toBeUndefined();
    expect(snapshotCostMicros({ priceInput: undefined, priceOutput: undefined }, usage)).toBeUndefined();
  });

  it('显式 NULL 价（模型未配价）→ NULL 成本，不回查兜底', () => {
    expect(snapshotCostMicros({ priceInput: null, priceOutput: null }, usage)).toBeNull();
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: null }, usage)).toBeNull();
  });

  it('usage 缺失（失败调用无 usage）→ 0 token → 成本 0', () => {
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, null)).toBe(0);
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, undefined)).toBe(0);
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, { promptTokens: 5 })).toBe(10);
  });

  it('cachedTokens 从 promptTokensDetails 读取', () => {
    expect(snapshotCostMicros(
      { priceInput: 1, priceOutput: 1 },
      { promptTokens: 100, promptTokensDetails: { cachedTokens: 40 }, completionTokens: 10 },
    )).toBe(90); // (100−20) + 10
  });
});
