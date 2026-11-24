import { describe, expect, it } from 'vitest';
import { normalizeImageUsage } from './image-api-client.js';

describe('normalizeImageUsage', () => {
  it('maps the OpenAI-shaped snake_case usage onto ChatUsage', () => {
    expect(normalizeImageUsage({
      input_tokens: 1840,
      output_tokens: 4096,
      total_tokens: 5936,
      input_tokens_details: { text_tokens: 120, image_tokens: 1720 },
    })).toEqual({ promptTokens: 1840, completionTokens: 4096, totalTokens: 5936 });
  });

  it('derives total from the parts when total_tokens is absent', () => {
    expect(normalizeImageUsage({ input_tokens: 12, output_tokens: 34 }))
      .toEqual({ promptTokens: 12, completionTokens: 34, totalTokens: 46 });
  });

  it('accepts a usage object that only carries total_tokens', () => {
    expect(normalizeImageUsage({ total_tokens: 77 }))
      .toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 77 });
  });

  it('returns null when there is no usage at all', () => {
    expect(normalizeImageUsage(undefined)).toBeNull();
    expect(normalizeImageUsage(null)).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(normalizeImageUsage('5936')).toBeNull();
    expect(normalizeImageUsage(42)).toBeNull();
    expect(normalizeImageUsage([1, 2])).toBeNull();
  });

  it('returns null for an empty object (no usage, not a zero-usage call)', () => {
    expect(normalizeImageUsage({})).toBeNull();
    // 只带 details 不算有 usage：没有任何 token 数可记
    expect(normalizeImageUsage({ input_tokens_details: { text_tokens: 5 } })).toBeNull();
  });

  it('zeroes dirty values instead of trusting them', () => {
    // 脏 input_tokens 归 0，但 total_tokens 本身合法就以它为准（上游声明的总消耗优先于
    // 解析不出来的分项）；分项之和与 total 不等是脏数据下的可接受失真
    expect(normalizeImageUsage({ input_tokens: '1840', output_tokens: 4096, total_tokens: 5936 }))
      .toEqual({ promptTokens: 0, completionTokens: 4096, totalTokens: 5936 });
    // NaN / 负数 / Infinity 一律归 0
    expect(normalizeImageUsage({ input_tokens: Number.NaN, output_tokens: 10, total_tokens: -5 }))
      .toEqual({ promptTokens: 0, completionTokens: 10, totalTokens: 10 });
    expect(normalizeImageUsage({ input_tokens: Number.POSITIVE_INFINITY, output_tokens: 1 }))
      .toEqual({ promptTokens: 0, completionTokens: 1, totalTokens: 1 });
    // 小数截断，不四舍五入（token 计数值）
    expect(normalizeImageUsage({ input_tokens: 10.7, output_tokens: 2 }))
      .toEqual({ promptTokens: 10, completionTokens: 2, totalTokens: 12 });
  });

  it('treats a zero total as missing and re-derives it from the parts', () => {
    // 上游偶发回 total_tokens: 0 但分项非零：按分项推导，别把真消耗记成 0
    expect(normalizeImageUsage({ input_tokens: 30, output_tokens: 40, total_tokens: 0 }))
      .toEqual({ promptTokens: 30, completionTokens: 40, totalTokens: 70 });
  });
});
