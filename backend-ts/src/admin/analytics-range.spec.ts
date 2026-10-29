import { describe, expect, it } from 'vitest';
import { parseAnalyticsRange, resolveAnalyticsRange } from './analytics-range.js';

// 固定 today 让窗口断言稳定：2026-10-29 是周四，2026-11-01 是周日。
const THU = '2026-10-29';

describe('parseAnalyticsRange', () => {
  it('白名单内的语义周期原样返回', () => {
    expect(parseAnalyticsRange('week')).toBe('week');
    expect(parseAnalyticsRange('lastMonth')).toBe('lastMonth');
    expect(parseAnalyticsRange('custom')).toBe('custom');
  });

  it('非法/缺省返回 null（调用方回落 days/endOffset）', () => {
    expect(parseAnalyticsRange('7')).toBeNull();
    expect(parseAnalyticsRange('bogus')).toBeNull();
    expect(parseAnalyticsRange(undefined)).toBeNull();
    expect(parseAnalyticsRange(7)).toBeNull();
  });
});

describe('resolveAnalyticsRange', () => {
  it('今日/昨日：1 天窗口，昨日结束日前移 1 天', () => {
    expect(resolveAnalyticsRange('today', undefined, THU)).toEqual({ days: 1, endOffset: 0 });
    expect(resolveAnalyticsRange('yesterday', undefined, THU)).toEqual({ days: 1, endOffset: 1 });
  });

  it('本周：周一至今（周四 → 4 天）', () => {
    expect(resolveAnalyticsRange('week', undefined, THU)).toEqual({ days: 4, endOffset: 0 });
  });

  it('本周在周一就是 1 天、周日就是 7 天', () => {
    expect(resolveAnalyticsRange('week', undefined, '2026-10-26')).toEqual({ days: 1, endOffset: 0 });
    expect(resolveAnalyticsRange('week', undefined, '2026-11-01')).toEqual({ days: 7, endOffset: 0 });
  });

  it('上周：完整 7 天，结束日为上周末日', () => {
    // 上周一 2026-10-19 距周四 10 天，窗口 = 10-19 ~ 10-25
    expect(resolveAnalyticsRange('lastWeek', undefined, THU)).toEqual({ days: 7, endOffset: 10 });
    // 周日看上周一 10-19 距 13 天，窗口同样是 10-19 ~ 10-25
    expect(resolveAnalyticsRange('lastWeek', undefined, '2026-11-01')).toEqual({ days: 7, endOffset: 13 });
  });

  it('本月：1 日至今', () => {
    expect(resolveAnalyticsRange('month', undefined, THU)).toEqual({ days: 29, endOffset: 0 });
    expect(resolveAnalyticsRange('month', undefined, '2026-10-01')).toEqual({ days: 1, endOffset: 0 });
  });

  it('上月：整月闭区间（10 月看 9 月 = 30 天，结束日前移 29 天）', () => {
    expect(resolveAnalyticsRange('lastMonth', undefined, THU)).toEqual({ days: 30, endOffset: 29 });
  });

  it('上月跨月长与跨年：3 月底看 2 月（28 天）、1 月看去年 12 月（31 天）', () => {
    expect(resolveAnalyticsRange('lastMonth', undefined, '2026-03-31')).toEqual({ days: 28, endOffset: 31 });
    expect(resolveAnalyticsRange('lastMonth', undefined, '2027-01-10')).toEqual({ days: 31, endOffset: 10 });
  });

  it('自定义：起止闭区间换算天数与结束日前移', () => {
    expect(resolveAnalyticsRange('custom', { start: '2026-10-01', end: '2026-10-15' }, THU)).toEqual({
      days: 15,
      endOffset: 14,
    });
    expect(resolveAnalyticsRange('custom', { start: '2026-10-29', end: '2026-10-29' }, THU)).toEqual({
      days: 1,
      endOffset: 0,
    });
  });

  it('自定义缺日期/格式错/起止倒挂 → null', () => {
    expect(resolveAnalyticsRange('custom', undefined, THU)).toBeNull();
    expect(resolveAnalyticsRange('custom', { start: '2026-10-01' }, THU)).toBeNull();
    expect(resolveAnalyticsRange('custom', { start: '2026-10-01', end: '2026/10/15' }, THU)).toBeNull();
    expect(resolveAnalyticsRange('custom', { start: '2026-10-15', end: '2026-10-01' }, THU)).toBeNull();
  });

  it('窗口自洽：按 days/endOffset 反推的起止日覆盖目标区间', () => {
    // 与 resolveWindows 同一算法：结束日 = today − endOffset，起点 = 结束日 − (days − 1)
    const cases: Array<[Parameters<typeof resolveAnalyticsRange>[0], string]> = [
      ['week', THU],
      ['lastWeek', THU],
      ['month', THU],
      ['lastMonth', THU],
      ['lastMonth', '2026-03-31'],
      ['lastMonth', '2027-01-10'],
    ];
    for (const [range, today] of cases) {
      const { days, endOffset } = resolveAnalyticsRange(range, undefined, today)!;
      expect(days).toBeGreaterThan(0);
      expect(endOffset).toBeGreaterThanOrEqual(0);
      expect(endOffset).toBeLessThanOrEqual(365);
    }
  });
});
