// 统计周期选项与自定义区间参数派生（UsageDrawer 用到的那套逻辑）。
// 覆盖：选项集合完整（上周/上月/自定义是新加的）、默认区间为最近 7 天、
// 只有 range=custom 才下发起止日（其他周期多发参数会干扰后端窗口计算）。
import { describe, expect, it } from 'vitest'
import { USAGE_PERIOD_OPTIONS, defaultCustomDateRange, usageDateRange } from './usage-range'

describe('统计周期选项', () => {
  it('九个周期，日历周期在前、滚动窗口居中、自定义收尾', () => {
    expect(USAGE_PERIOD_OPTIONS.map(o => o.value)).toEqual([
      'today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth', 'last7', 'last30', 'custom',
    ])
    expect(USAGE_PERIOD_OPTIONS.map(o => o.label)).toEqual([
      '今日', '昨日', '本周', '上周', '本月', '上月', '近 7 天', '近 30 天', '自定义',
    ])
  })

  it('选项 value 不重复（el-segmented 靠 value 区分选中项）', () => {
    const values = USAGE_PERIOD_OPTIONS.map(o => o.value)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('defaultCustomDateRange', () => {
  it('默认最近 7 天：起日为今天-6，止日为今天', () => {
    expect(defaultCustomDateRange(new Date(2026, 9, 10))).toEqual({
      startDate: '2026-10-04',
      endDate: '2026-10-10',
    })
  })

  it('跨月退回上一个月（2026-03-02 → 02-24..03-02）', () => {
    expect(defaultCustomDateRange(new Date(2026, 2, 2))).toEqual({
      startDate: '2026-02-24',
      endDate: '2026-03-02',
    })
  })

  it('跨年退回上一年（2026-01-03 → 2025-12-28..2026-01-03）', () => {
    expect(defaultCustomDateRange(new Date(2026, 0, 3))).toEqual({
      startDate: '2025-12-28',
      endDate: '2026-01-03',
    })
  })
})

describe('usageDateRange', () => {
  const custom = { startDate: '2026-09-08', endDate: '2026-09-12' }

  it('custom 周期透传起止日', () => {
    expect(usageDateRange('custom', custom)).toEqual(custom)
  })

  it('非 custom 周期一律不下发，避免干扰后端窗口计算', () => {
    for (const range of ['today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth', 'last7', 'last30'] as const) {
      expect(usageDateRange(range, custom)).toBeUndefined()
    }
  })

  it('custom 但日期缺失（半成品状态）→ 不下发', () => {
    expect(usageDateRange('custom', undefined)).toBeUndefined()
    expect(usageDateRange('custom', { startDate: '', endDate: '' })).toBeUndefined()
    expect(usageDateRange('custom', { startDate: '2026-09-08', endDate: '' })).toBeUndefined()
  })
})
