// 统计周期的日历数学、粒度默认值与 URL/查询映射。
// 覆盖：新增的日历周期（本周/上周/本月/上月）与自定义区间、边界（周一/周日/月初/跨年）、
// 以及缓存键只认周期语义（自定义必须带起止日）。
import { describe, expect, it } from 'vitest'
import {
  MAX_CUSTOM_DAYS,
  PERIOD_GROUPS,
  buildAnalyticsQuery,
  customRangeFromQuery,
  daysBetweenYmd,
  defaultCustomRange,
  defaultTrendGrain,
  normalizeTrendGrain,
  periodDays,
  periodFallbackText,
  periodFromQueryValue,
  periodKey,
  periodLabel,
  periodToQueryValue,
  todayYmd
} from './useAnalyticsPeriod'
import type { CustomPeriodRange } from '../types'

// 固定“今天”：2026-10-29 周四（周一 10-26、上周一 10-19、上月 = 9 月 30 天）
const THU = '2026-10-29'

const custom = (start: string, end: string): CustomPeriodRange => ({ start, end })

describe('周期选项', () => {
  it('两组预设：日历周期 6 项 + 滚动窗口 4 项，value 不重复', () => {
    expect(PERIOD_GROUPS.map((g) => g.label)).toEqual(['日历周期', '最近'])
    expect(PERIOD_GROUPS[0].options.map((o) => o.value)).toEqual([
      'today',
      'yesterday',
      'week',
      'lastWeek',
      'month',
      'lastMonth'
    ])
    expect(PERIOD_GROUPS[1].options.map((o) => o.value)).toEqual([3, 7, 30, 90])
    const values = PERIOD_GROUPS.flatMap((g) => g.options).map((o) => String(o.value))
    expect(new Set(values).size).toBe(values.length)
  })

  it('periodLabel 覆盖全部周期，自定义有专门文案', () => {
    expect(periodLabel('today')).toBe('今日')
    expect(periodLabel('week')).toBe('本周')
    expect(periodLabel('lastMonth')).toBe('上月')
    expect(periodLabel(30)).toBe('近 30 天')
    expect(periodLabel('custom')).toBe('自定义')
  })
})

describe('todayYmd', () => {
  it('按 Asia/Shanghai 取日：UTC 当天 16:00 之后北京时间已是次日', () => {
    // 2026-10-29T16:30:00Z = 北京 10-30 00:30
    expect(todayYmd(new Date('2026-10-29T16:30:00Z'))).toBe('2026-10-30')
    // 2026-10-29T15:59:00Z = 北京 10-29 23:59
    expect(todayYmd(new Date('2026-10-29T15:59:00Z'))).toBe('2026-10-29')
  })
})

describe('periodDays', () => {
  it('今日/昨日/滚动窗口', () => {
    expect(periodDays('today', undefined, THU)).toBe(1)
    expect(periodDays('yesterday', undefined, THU)).toBe(1)
    expect(periodDays(3, undefined, THU)).toBe(3)
    expect(periodDays(90, undefined, THU)).toBe(90)
  })

  it('本周 = 周一至今（周四 4 天，周一 1 天，周日 7 天）', () => {
    expect(periodDays('week', undefined, THU)).toBe(4)
    expect(periodDays('week', undefined, '2026-10-26')).toBe(1)
    expect(periodDays('week', undefined, '2026-11-01')).toBe(7)
  })

  it('上周固定 7 天', () => {
    expect(periodDays('lastWeek', undefined, THU)).toBe(7)
    expect(periodDays('lastWeek', undefined, '2026-11-01')).toBe(7)
  })

  it('本月 = 1 日至今', () => {
    expect(periodDays('month', undefined, THU)).toBe(29)
    expect(periodDays('month', undefined, '2026-10-01')).toBe(1)
  })

  it('上月 = 整月天数（跨月长/跨年）', () => {
    expect(periodDays('lastMonth', undefined, THU)).toBe(30)
    expect(periodDays('lastMonth', undefined, '2026-03-31')).toBe(28)
    expect(periodDays('lastMonth', undefined, '2027-01-10')).toBe(31)
  })

  it('自定义按起止日跨度；缺日期/倒挂按最长窗口兜底', () => {
    expect(periodDays('custom', custom('2026-10-01', '2026-10-15'), THU)).toBe(15)
    expect(periodDays('custom', custom('2026-10-29', '2026-10-29'), THU)).toBe(1)
    expect(periodDays('custom', custom('2026-10-15', '2026-10-01'), THU)).toBe(MAX_CUSTOM_DAYS)
    expect(periodDays('custom', undefined, THU)).toBe(MAX_CUSTOM_DAYS)
    expect(periodDays('custom', custom('', ''), THU)).toBe(MAX_CUSTOM_DAYS)
  })
})

describe('defaultTrendGrain / normalizeTrendGrain', () => {
  it('不足 7 天按小时，否则按天', () => {
    expect(defaultTrendGrain('today')).toBe('hour')
    expect(defaultTrendGrain('week', undefined, '2026-10-26')).toBe('hour')
    expect(defaultTrendGrain('week', undefined, '2026-10-29')).toBe('hour') // 4 天
    expect(defaultTrendGrain('week', undefined, '2026-11-01')).toBe('day') // 7 天
    expect(defaultTrendGrain('lastWeek')).toBe('day')
    expect(defaultTrendGrain('month')).toBe('day')
    expect(defaultTrendGrain('lastMonth')).toBe('day')
    expect(defaultTrendGrain(7)).toBe('day')
    expect(defaultTrendGrain('custom', custom('2026-10-01', '2026-10-03'))).toBe('hour')
    expect(defaultTrendGrain('custom', custom('2026-10-01', '2026-10-31'))).toBe('day')
  })

  it('URL 显式粒度优先，缺省才按周期推导', () => {
    expect(normalizeTrendGrain('day', 'today')).toBe('day')
    expect(normalizeTrendGrain('hour', 'month')).toBe('hour')
    expect(normalizeTrendGrain(undefined, 'today')).toBe('hour')
    expect(normalizeTrendGrain('bogus', 'month')).toBe('day')
  })
})

describe('URL 映射', () => {
  it('周期值原样往返', () => {
    for (const value of ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth', 3, 90] as const) {
      expect(periodFromQueryValue(periodToQueryValue(value))).toBe(value)
    }
  })

  it('自定义必须带合法起止日，否则回落今日', () => {
    expect(periodFromQueryValue('custom', '2026-10-01', '2026-10-15')).toBe('custom')
    expect(periodFromQueryValue('custom', '2026-10-01')).toBe('today')
    expect(periodFromQueryValue('custom', '2026-10-15', '2026-10-01')).toBe('today')
    expect(periodFromQueryValue('custom', '2026-13-01', '2026-10-15')).toBe('today')
    expect(periodFromQueryValue('bogus')).toBe('today')
    expect(periodFromQueryValue('7')).toBe(7)
  })

  it('customRangeFromQuery 非法回落默认区间（最近 7 天）', () => {
    expect(customRangeFromQuery('2026-10-01', '2026-10-15')).toEqual({ start: '2026-10-01', end: '2026-10-15' })
    expect(customRangeFromQuery(undefined, undefined)).toEqual({ start: '2026-10-23', end: '2026-10-29' })
    expect(customRangeFromQuery('2026-10-15', '2026-10-01')).toEqual({ start: '2026-10-23', end: '2026-10-29' })
  })

  it('defaultCustomRange 跨月/跨年退回', () => {
    expect(defaultCustomRange('2026-03-02')).toEqual({ start: '2026-02-24', end: '2026-03-02' })
    expect(defaultCustomRange('2027-01-03')).toEqual({ start: '2026-12-28', end: '2027-01-03' })
  })
})

describe('buildAnalyticsQuery / periodKey', () => {
  it('只有自定义周期才带起止日', () => {
    expect(buildAnalyticsQuery('week')).toEqual({ range: 'week' })
    expect(buildAnalyticsQuery(7)).toEqual({ range: 7 })
    expect(buildAnalyticsQuery('custom', custom('2026-10-01', '2026-10-15'))).toEqual({
      range: 'custom',
      start: '2026-10-01',
      end: '2026-10-15'
    })
    // 自定义区间半成品：不下发，避免后端拿不到起止日
    expect(buildAnalyticsQuery('custom', custom('', ''))).toEqual({ range: 'custom' })
    expect(buildAnalyticsQuery('today', custom('2026-10-01', '2026-10-15'))).toEqual({ range: 'today' })
  })

  it('limit 透传', () => {
    expect(buildAnalyticsQuery('week', undefined, 100)).toEqual({ range: 'week', limit: 100 })
  })

  it('缓存键区分周期与自定义区间，其他周期不因区间变化 miss', () => {
    // 键 = scope|range|start|end|limit|modelId|excludeConnectivity|granularity|scene|scope
    expect(periodKey('overview', buildAnalyticsQuery('week'))).toBe('overview|week||||||||')
    const customA = periodKey('overview', buildAnalyticsQuery('custom', custom('2026-10-01', '2026-10-15')))
    const customB = periodKey('overview', buildAnalyticsQuery('custom', custom('2026-10-02', '2026-10-15')))
    expect(customA).toBe('overview|custom|2026-10-01|2026-10-15||||||')
    expect(customA).not.toBe(customB)
    // 非自定义周期即使内存里留着自定义区间，键也不带区间
    expect(periodKey('overview', buildAnalyticsQuery('today', custom('2026-10-01', '2026-10-15')))).toBe(
      'overview|today||||||||'
    )
  })
})

describe('periodFallbackText', () => {
  it('各周期都有可读文案', () => {
    expect(periodFallbackText('today')).toBe('今日 00:00 起')
    expect(periodFallbackText('yesterday')).toBe('昨日 00:00 起')
    expect(periodFallbackText('week')).toBe('本周（周一至今）')
    expect(periodFallbackText('lastWeek')).toBe('上周（周一至周日）')
    expect(periodFallbackText('month')).toBe('本月（1 日至今）')
    expect(periodFallbackText('lastMonth')).toBe('上月（整月）')
    expect(periodFallbackText(7)).toBe('近 7 天')
    expect(periodFallbackText('custom', custom('2026-10-01', '2026-10-15'))).toBe('2026-10-01 ~ 2026-10-15')
    expect(periodFallbackText('custom')).toBe('自定义区间')
  })
})

describe('daysBetweenYmd', () => {
  it('跨月/跨年/闰日', () => {
    expect(daysBetweenYmd('2026-10-19', '2026-10-29')).toBe(10)
    expect(daysBetweenYmd('2026-09-30', '2026-10-29')).toBe(29)
    expect(daysBetweenYmd('2026-02-01', '2026-03-01')).toBe(28)
    expect(daysBetweenYmd('2024-02-01', '2024-03-01')).toBe(29)
    expect(daysBetweenYmd('2026-12-31', '2027-01-01')).toBe(1)
  })
})
