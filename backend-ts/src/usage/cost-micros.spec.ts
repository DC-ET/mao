import { describe, expect, it } from 'vitest';
import { computeCostMicros, parsePriceColumn, snapshotCostMicros } from './cost-micros.js';

/** 四项价格齐全的默认配置：非缓存输入 2 / 缓存读 1 / 缓存写 2 / 输出 8。 */
const PRICES = { priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8 };

function usage(promptTokens: number, cachedTokens: number, cacheCreationTokens: number, completionTokens: number) {
  return { promptTokens, cachedTokens, cacheCreationTokens, completionTokens };
}

describe('computeCostMicros', () => {
  it('锚点用例（技术方案 §7）：non_cached=600 / cache_read=400 / cache_write=0 / completion=200 → 3200', () => {
    // 600×2 + 400×1 + 0×2 + 200×8 = 3200
    expect(computeCostMicros(PRICES, usage(1000, 400, 0, 200))).toBe(3200);
  });

  it('OpenAI 口径：cached ⊆ prompt，prompt − cached 为非缓存输入', () => {
    // prompt=1000, cached=400 → 非缓存 600：600×2 + 400×1 + 200×8 = 3200
    expect(computeCostMicros(PRICES, usage(1000, 400, 0, 200))).toBe(3200);
    // 无缓存时全额计输入：1000×2 + 100×8（缓存读价改 3 不影响）= 2800
    expect(computeCostMicros({ ...PRICES, priceCacheRead: 3 }, usage(1000, 0, 0, 100))).toBe(2800);
  });

  it('Anthropic 口径：prompt = input + cache_creation + cache_read，三项分别计价', () => {
    // input=600 + cache_read=400 + cache_creation=200：600×2 + 400×1 + 200×2 + 200×8 = 3600
    expect(computeCostMicros(PRICES, usage(1200, 400, 200, 200))).toBe(3600);
  });

  it('缓存写单独计价：OpenAI 系 cache_write=0 不影响成本', () => {
    expect(computeCostMicros(PRICES, usage(1000, 400, 0, 200))).toBe(3200);
    // 换成 Anthropic 结构（200 计入缓存写）成本增加 200
    expect(computeCostMicros(PRICES, usage(1200, 400, 200, 200))).toBe(3600);
  });

  it('产生了缓存读但 price_cache_read 为 null → NULL（宁可整行不计，不可低估）', () => {
    expect(computeCostMicros({ ...PRICES, priceCacheRead: null }, usage(1000, 400, 0, 200))).toBeNull();
    expect(computeCostMicros({ priceInput: 2, priceCacheRead: null, priceCacheWrite: null, priceOutput: 8 }, usage(1000, 400, 0, 200))).toBeNull();
  });

  it('产生了缓存写但 price_cache_write 为 null → NULL', () => {
    expect(computeCostMicros({ ...PRICES, priceCacheWrite: null }, usage(1200, 400, 200, 200))).toBeNull();
  });

  it('token 为 0 的类型即使价格为 null 也不影响计价（本地模型只填输入 / 输出）', () => {
    // 无缓存读、无缓存写 → 两项缓存价留空也能正常计：1000×2 + 200×8 = 3600
    expect(computeCostMicros(
      { priceInput: 2, priceCacheRead: null, priceCacheWrite: null, priceOutput: 8 },
      usage(1000, 0, 0, 200),
    )).toBe(3600);
    // 有输出 token 而输出价缺失 → NULL
    expect(computeCostMicros(
      { priceInput: 2, priceCacheRead: null, priceCacheWrite: null, priceOutput: null },
      usage(1000, 0, 0, 200),
    )).toBeNull();
  });

  it('非缓存输入缺失价格 → NULL', () => {
    expect(computeCostMicros({ ...PRICES, priceInput: null }, usage(1000, 0, 0, 0))).toBeNull();
  });

  it('price 整体为 null/undefined → NULL', () => {
    expect(computeCostMicros(null, usage(1000, 0, 0, 100))).toBeNull();
    expect(computeCostMicros(undefined, usage(1000, 0, 0, 100))).toBeNull();
  });

  it('价格 0 是合法免费模型：成本为 0 而非 NULL', () => {
    expect(computeCostMicros({ priceInput: 0, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 0 }, usage(100, 40, 10, 100))).toBe(0);
  });

  it('token 全 0 → 成本 0（即便缓存价未配）', () => {
    expect(computeCostMicros({ priceInput: 2, priceCacheRead: null, priceCacheWrite: null, priceOutput: 8 }, usage(0, 0, 0, 0))).toBe(0);
  });

  it('cached > prompt 时钳制，不产生负成本', () => {
    // prompt=100, cached=500 → cached 钳到 100，非缓存 0、缓存写 0：100×1 = 100
    expect(computeCostMicros(PRICES, usage(100, 500, 0, 0))).toBe(100);
    // 加 50 输出 token：100×1 + 50×8 = 500
    expect(computeCostMicros(PRICES, usage(100, 500, 0, 50))).toBe(500);
  });

  it('cached + cache_creation > prompt 时逐级钳制，非缓存不为负', () => {
    // prompt=100, cached=60, cache_write=200 → cached 钳到 60，cache_write 钳到 40，非缓存 0：
    // 60×1 + 40×2 = 140
    expect(computeCostMicros(PRICES, usage(100, 60, 200, 0))).toBe(140);
  });

  it('非数字 / 负 token 归一为 0', () => {
    expect(computeCostMicros(PRICES, usage(NaN, undefined as unknown as number, null as unknown as number, -5))).toBe(0);
  });

  it('小数价格四舍五入到整数微单位', () => {
    // 缓存写 3 token × 0.333333 = 0.999999 → round → 1（缓存写 token 3 需 prompt≥3）
    expect(computeCostMicros(
      { priceInput: 0, priceCacheRead: 0, priceCacheWrite: 0.333333, priceOutput: 0 },
      usage(3, 0, 3, 0),
    )).toBe(1);
  });

  it('大数精度：2×10¹⁵ 微单位无漂移（< 2⁵³）', () => {
    const micros = computeCostMicros(
      { priceInput: 0, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 1 },
      usage(0, 0, 0, 2_000_000_000_000_000),
    );
    expect(micros).toBe(2_000_000_000_000_000);
    expect(Number.isSafeInteger(micros)).toBe(true);

    // 手算锚点：non_cached = 1e11 − 4e10 = 6e10；cache_read = 4e10；completion = 1e10
    // 6e10×12.345678 + 4e10×1.234567 + 1e10×98.765432
    //   = 740,740,680,000,000 + 49,382,680,000,000 + 987,654,320,000
    //   = 1,777,777,680,000
    const mixed = computeCostMicros(
      { priceInput: 12.345678, priceCacheRead: 1.234567, priceCacheWrite: 0, priceOutput: 98.765432 },
      usage(100_000_000_000, 40_000_000_000, 0, 10_000_000_000),
    );
    expect(mixed).toBe(1_777_777_680_000);
    expect(Number.isSafeInteger(mixed)).toBe(true);
  });

  it('迁移口径等价（决策 16）：pr = pi×0.5、pw = pi 时逐项展开 = 原 5 折公式', () => {
    // V138：prompt_billable = 1000 − 400×0.5 = 800；800×2 + 200×8 = 3200
    const legacy = computeCostMicros(
      { priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8 },
      usage(1000, 400, 0, 200),
    );
    expect(legacy).toBe(3200);
    // 逐项：600×2 + 400×1 = 1600；原公式 800×2 = 1600 —— 一致
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
  // 与 ChatUsage 口径一致：缓存读在 promptTokensDetails.cachedTokens，缓存写在 cacheCreationTokens
  const usage = { promptTokens: 1000, promptTokensDetails: { cachedTokens: 400 }, completionTokens: 200 };

  it('价格随配置下发 → 写时快照计价', () => {
    expect(snapshotCostMicros(PRICES, usage)).toBe(3200);
  });

  it('价格字段全缺失（undefined）→ undefined，交由 LlmCallService 走兜底缓存', () => {
    expect(snapshotCostMicros({}, usage)).toBeUndefined();
    expect(snapshotCostMicros({ priceInput: undefined, priceCacheRead: undefined, priceCacheWrite: undefined, priceOutput: undefined }, usage)).toBeUndefined();
  });

  it('部分字段缺失（undefined）按未配价处理，不回查兜底', () => {
    // 只下发输入/输出两项（缓存价 undefined）且本次有缓存读 → 缓存读未配价 → NULL
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, usage)).toBeNull();
    // 无缓存 token 时只填输入/输出即可正常计价：1000×2 + 200×8 = 3600
    expect(snapshotCostMicros({ priceInput: 2, priceOutput: 8 }, { promptTokens: 1000, completionTokens: 200 })).toBe(3600);
  });

  it('显式 NULL 价（模型未配价或该类未配价）→ NULL 成本，不回查兜底', () => {
    expect(snapshotCostMicros({ priceInput: null, priceCacheRead: null, priceCacheWrite: null, priceOutput: null }, usage)).toBeNull();
    expect(snapshotCostMicros({ ...PRICES, priceCacheRead: null }, usage)).toBeNull();
  });

  it('usage 缺失（失败调用无 usage）→ 0 token → 成本 0', () => {
    expect(snapshotCostMicros(PRICES, null)).toBe(0);
    expect(snapshotCostMicros(PRICES, undefined)).toBe(0);
    expect(snapshotCostMicros(PRICES, { promptTokens: 5 })).toBe(10);
  });

  it('Anthropic cacheCreationTokens 从 promptTokensDetails 读取并单独计价', () => {
    expect(snapshotCostMicros(
      PRICES,
      { promptTokens: 1200, promptTokensDetails: { cachedTokens: 400, cacheCreationTokens: 200 }, completionTokens: 200 },
    )).toBe(3600);
  });

  it('cacheCreationTokens 缺省为 0（OpenAI 系不传该字段）', () => {
    expect(snapshotCostMicros(
      PRICES,
      { promptTokens: 1000, promptTokensDetails: { cachedTokens: 400 }, completionTokens: 200 },
    )).toBe(3200);
  });
});
