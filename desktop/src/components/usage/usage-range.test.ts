// 统计周期分组、自定义区间参数派生与合法性（PeriodPicker / UsageDrawer 用到的那套逻辑）。
// 覆盖：分组选项完整、周期文案、上海时区日历数学、自定义区间默认值与下发口径、
// 两个日期选择器互相对应的禁用规则、以及超长区间的兜底收敛。
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_PERIOD_LABEL,
  MAX_CUSTOM_DAYS,
  MAX_CUSTOM_LOOKBACK_DAYS,
  PERIOD_GROUPS,
  PERIOD_OPTIONS,
  addDaysYmd,
  customRangeBounds,
  daysBetweenYmd,
  defaultCustomDateRange,
  isCustomDateDisabled,
  isValidYmd,
  normalizeCustomRange,
  periodLabel,
  todayYmd,
  usageDateRange,
  ymdToLocalDate
} from './usage-range'

describe('统计周期分组', () => {
  it('日历周期 6 项在前、最近 2 项在后（自定义区间是弹层底部入口，不在分组里）', () => {
    expect(PERIOD_GROUPS.map(g => g.label)).toEqual(['日历周期', '最近'])
    expect(PERIOD_GROUPS[0].options.map(o => o.value)).toEqual([
      'today', 'yesterday', 'week', 'lastWeek', 'month', 'lastMonth',
    ])
    expect(PERIOD_GROUPS[1].options.map(o => o.value)).toEqual(['last7', 'last30'])
  })

  it('扁平表 8 项且不含 custom（custom 由 CUSTOM_PERIOD_LABEL 单独给文案）', () => {
    expect(PERIOD_OPTIONS).toHaveLength(8)
    expect(PERIOD_OPTIONS.some(o => o.value === 'custom')).toBe(false)
    expect(CUSTOM_PERIOD_LABEL).toBe('自定义')
  })

  it('选项 value 不重复（弹层按 value 区分选中项）', () => {
    const values = PERIOD_OPTIONS.map(o => o.value)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('periodLabel', () => {
  it('每个预设周期都给中文文案，custom 给「自定义」', () => {
    expect(periodLabel('today')).toBe('今日')
    expect(periodLabel('yesterday')).toBe('昨日')
    expect(periodLabel('week')).toBe('本周')
    expect(periodLabel('lastWeek')).toBe('上周')
    expect(periodLabel('month')).toBe('本月')
    expect(periodLabel('lastMonth')).toBe('上月')
    expect(periodLabel('last7')).toBe('近 7 天')
    expect(periodLabel('last30')).toBe('近 30 天')
    expect(periodLabel('custom')).toBe('自定义')
  })

  it('白名单外的值回落 last30 文案（后端同口径回落 last30 窗口）', () => {
    expect(periodLabel('nope' as never)).toBe('近 30 天')
  })
})

describe('todayYmd', () => {
  it('按 Asia/Shanghai 取日：UTC 16:30 已是上海次日凌晨', () => {
    expect(todayYmd(new Date('2026-10-29T16:30:00Z'))).toBe('2026-10-30')
  })

  it('UTC 15:59 仍是上海当天 23:59', () => {
    expect(todayYmd(new Date('2026-10-29T15:59:00Z'))).toBe('2026-10-29')
  })
})

describe('日历数学', () => {
  it('addDaysYmd 跨月跨年、负向都正确', () => {
    expect(addDaysYmd('2026-10-29', 1)).toBe('2026-10-30')
    expect(addDaysYmd('2026-10-01', -1)).toBe('2026-09-30')
    expect(addDaysYmd('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDaysYmd('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysYmd('2026-10-29', 0)).toBe('2026-10-29')
  })

  it('daysBetweenYmd 同日为 0，跨月按日历天算', () => {
    expect(daysBetweenYmd('2026-10-29', '2026-10-29')).toBe(0)
    expect(daysBetweenYmd('2026-09-30', '2026-10-01')).toBe(1)
    expect(daysBetweenYmd('2026-10-01', '2026-10-29')).toBe(28)
  })

  it('isValidYmd 只认真实存在的日历日', () => {
    expect(isValidYmd('2026-10-29')).toBe(true)
    expect(isValidYmd('2026-02-29')).toBe(false)
    expect(isValidYmd('2026-13-01')).toBe(false)
    expect(isValidYmd('2026-1-1')).toBe(false)
    expect(isValidYmd('')).toBe(false)
    expect(isValidYmd(null)).toBe(false)
  })
})

describe('defaultCustomDateRange', () => {
  it('默认最近 7 天：起日为今天-6，止日为今天', () => {
    expect(defaultCustomDateRange(new Date('2026-10-10T00:00:00Z'))).toEqual({
      startDate: '2026-10-04',
      endDate: '2026-10-10',
    })
  })

  it('跨月退回上一个月（2026-03-02 → 02-24..03-02）', () => {
    expect(defaultCustomDateRange(new Date('2026-03-02T00:00:00Z'))).toEqual({
      startDate: '2026-02-24',
      endDate: '2026-03-02',
    })
  })

  it('跨年退回上一年（2026-01-03 → 2025-12-28..2026-01-03）', () => {
    expect(defaultCustomDateRange(new Date('2026-01-03T00:00:00Z'))).toEqual({
      startDate: '2025-12-28',
      endDate: '2026-01-03',
    })
  })

  it('按上海时区取今天：UTC 16:30 时止日已是上海次日', () => {
    expect(defaultCustomDateRange(new Date('2026-10-29T16:30:00Z'))).toEqual({
      startDate: '2026-10-24',
      endDate: '2026-10-30',
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

describe('customRangeBounds', () => {
  const today = '2026-10-29'
  const bounds = customRangeBounds(today)

  it('最早可选日是 365 天前，最晚是今天', () => {
    expect(bounds.min).toEqual(ymdToLocalDate(addDaysYmd(today, -MAX_CUSTOM_LOOKBACK_DAYS)))
    expect(bounds.max).toEqual(ymdToLocalDate(today))
  })
})

describe('isCustomDateDisabled', () => {
  const today = '2026-10-29'
  const bounds = customRangeBounds(today)
  const range = { start: '2026-10-20', end: '2026-10-29' }

  it('未来日期与一年以前的日期两端都置灰', () => {
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-30'), 'start', range, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-30'), 'end', range, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2025-10-28'), 'start', range, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2025-10-28'), 'end', range, bounds)).toBe(true)
  })

  it('区间内的日期两端都可选', () => {
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-20'), 'start', range, bounds)).toBe(false)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-29'), 'end', range, bounds)).toBe(false)
  })

  it('起点不能晚于终点', () => {
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-30'), 'start', range, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-29'), 'start', range, bounds)).toBe(false)
  })

  it('终点不能早于起点', () => {
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-19'), 'end', range, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-20'), 'end', range, bounds)).toBe(false)
  })

  it(`跨度超过 ${MAX_CUSTOM_DAYS} 天的组合选不出来`, () => {
    const longRange = { start: '2026-08-01', end: '2026-10-29' }
    // 起点早于「终点 − 89 天」置灰：从源头上凑不出 90 天以上的区间
    expect(isCustomDateDisabled(ymdToLocalDate('2026-07-31'), 'start', longRange, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-08-01'), 'start', longRange, bounds)).toBe(false)
    // 终点晚于「起点 + 89 天」置灰
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-30'), 'end', longRange, bounds)).toBe(true)
    expect(isCustomDateDisabled(ymdToLocalDate('2026-10-29'), 'end', longRange, bounds)).toBe(false)
  })
})

describe('normalizeCustomRange', () => {
  it('合法区间原样下发', () => {
    expect(normalizeCustomRange('2026-09-08', '2026-09-12')).toEqual({
      startDate: '2026-09-08',
      endDate: '2026-09-12',
    })
  })

  it('起止颠倒时交换', () => {
    expect(normalizeCustomRange('2026-09-12', '2026-09-08')).toEqual({
      startDate: '2026-09-08',
      endDate: '2026-09-12',
    })
  })

  it('跨度超上限时保留终点，起点拉到最长跨度处', () => {
    expect(normalizeCustomRange('2026-01-01', '2026-10-29')).toEqual({
      startDate: addDaysYmd('2026-10-29', -(MAX_CUSTOM_DAYS - 1)),
      endDate: '2026-10-29',
    })
  })

  it('任一端非法 → null（调用方保持原状，不发请求）', () => {
    expect(normalizeCustomRange('', '2026-10-29')).toBeNull()
    expect(normalizeCustomRange('2026-10-29', 'not-a-date')).toBeNull()
  })
})
