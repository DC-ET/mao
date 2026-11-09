import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_RANGE_DEFAULT,
  activityRangeParams,
  defaultCustomRange,
  isActivityRangeValue,
  shanghaiToday,
  shiftDate
} from './sessionActivityRange'

describe('session activity range', () => {
  it('defaults to the 7-day preset', () => {
    expect(ACTIVITY_RANGE_DEFAULT).toBe('7D')
    expect(activityRangeParams('1D', null)).toEqual({ range: '1D' })
    expect(activityRangeParams('3D', null)).toEqual({ range: '3D' })
    expect(activityRangeParams('7D', null)).toEqual({ range: '7D' })
    expect(activityRangeParams('30D', null)).toEqual({ range: '30D' })
    // 非法档位回落默认，避免地址栏拼错就把时间窗关掉
    expect(activityRangeParams('5Y', null)).toEqual({ range: '7D' })
    expect(isActivityRangeValue('1D')).toBe(true)
    expect(isActivityRangeValue('3D')).toBe(true)
    expect(isActivityRangeValue('90D')).toBe(true)
    expect(isActivityRangeValue('all')).toBe(false)
  })

  it('sends ALL to bypass the window', () => {
    expect(activityRangeParams('ALL', null)).toEqual({ range: 'ALL' })
  })

  it('sends explicit dates for the custom preset', () => {
    expect(activityRangeParams('CUSTOM', ['2026-11-01', '2026-11-06'])).toEqual({
      dateFrom: '2026-11-01',
      dateTo: '2026-11-06'
    })
    // 未选日期时不发参数，由后端默认窗口兜底
    expect(activityRangeParams('CUSTOM', null)).toEqual({})
    expect(activityRangeParams('CUSTOM', ['', ''])).toEqual({})
  })

  it('computes the default custom range as the last 7 shanghai calendar days', () => {
    // 2026-11-06T02:00:00Z = 上海 2026-11-06 10:00
    expect(defaultCustomRange(new Date('2026-11-06T02:00:00Z'))).toEqual(['2026-10-31', '2026-11-06'])
    // 跨月与跨年
    expect(shiftDate('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
    // 上海日历日：UTC 16:30 已是次日 00:30
    expect(shanghaiToday(new Date('2026-11-06T16:30:00Z'))).toBe('2026-11-07')
  })
})
