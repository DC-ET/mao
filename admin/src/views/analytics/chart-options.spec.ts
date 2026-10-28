import { describe, expect, it } from 'vitest'
import {
  costTrendOption,
  formatCompact,
  formatCost,
  formatTokens,
  qualityTrendOption,
  trafficTrendOption,
  type TrendPoint
} from './chart-options'

/**
 * Token 紧凑展示全站统一保留两位小数（0.0.302：从一位改为两位，覆盖图表与各 Tab）。
 * 单测锁住默认两位、显式传 1 的一位口径，避免再出现「改了一处漏了其余」。
 */
describe('formatCompact', () => {
  it('默认一位小数并去掉整数部分多余的 .0', () => {
    expect(formatCompact(17_000)).toBe('1.7 万')
    expect(formatCompact(20_000)).toBe('2 万')
    expect(formatCompact(120_000_000)).toBe('1.2 亿')
  })

  it('KPI 口径固定两位小数', () => {
    expect(formatCompact(17_000, 2)).toBe('1.70 万')
    expect(formatCompact(20_000, 2)).toBe('2.00 万')
    expect(formatCompact(123_450_000, 2)).toBe('1.23 亿')
  })

  it('万以下原样展示', () => {
    expect(formatCompact(9999)).toBe('9999')
  })
})

describe('formatTokens', () => {
  it('默认两位小数：1.4B → 1.40B', () => {
    expect(formatTokens(1_400_000_000)).toBe('1.40B')
    expect(formatTokens(1_450_000_000)).toBe('1.45B')
    expect(formatTokens(2_000_000)).toBe('2.00M')
    expect(formatTokens(20_400)).toBe('20.40K')
    expect(formatTokens(1_500)).toBe('1.50K')
  })

  it('显式传 1 仍按一位小数（留给需要短刻轴的场合）', () => {
    expect(formatTokens(1_400_000_000, 1)).toBe('1.4B')
    expect(formatTokens(2_000_000, 1)).toBe('2M')
    expect(formatTokens(20_400, 1)).toBe('20.4K')
  })

  it('小于 1000 不走紧凑单位', () => {
    expect(formatTokens(999)).toBe('999')
  })

  it('负数按绝对值选档，符号保留', () => {
    expect(formatTokens(-1_450_000_000)).toBe('-1.45B')
  })
})

describe('formatCost', () => {
  it('最多两位小数', () => {
    expect(formatCost(144.99)).toBe('144.99')
    expect(formatCost(183.256)).toBe('183.26')
  })

  it('null 与非法值显示 -', () => {
    expect(formatCost(null)).toBe('-')
    expect(formatCost(Number.NaN)).toBe('-')
  })
})

describe('qualityTrendOption', () => {
  const trends: TrendPoint[] = [
    {
      date: '2026-10-27',
      sessions: 1,
      messages: 2,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0,
      callSuccessRate: 100,
      cacheHitRate: 10,
      avgDurationMs: 4000,
      avgFirstTokenMs: 800,
    },
    {
      date: '2026-10-28',
      sessions: 0,
      messages: 0,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0,
      callSuccessRate: null,
      cacheHitRate: null,
      avgDurationMs: null,
      avgFirstTokenMs: null,
    },
  ]

  it('四条线：百分比走左轴，平均耗时挂右轴并用虚线区分单位', () => {
    const option = qualityTrendOption(trends) as unknown as QualityOptionLike
    const series = option.series
    expect(series.map((s) => s.name)).toEqual(['成功率%', '缓存命中率%', '平均总耗时', '平均首字耗时'])
    // 前两条挂默认左轴，后两条显式 yAxisIndex=1；右轴不设 max，按 ms 量级自动缩放
    expect(series.slice(0, 2).every((s) => s.yAxisIndex == null)).toBe(true)
    expect(series.slice(2).every((s) => s.yAxisIndex === 1 && s.lineStyle?.type === 'dashed')).toBe(true)
    expect(series[2].data).toEqual([4000, null])
    expect(series[3].data).toEqual([800, null])
    const [left, right] = option.yAxis
    expect(left.max).toBe(100)
    expect(left.axisLabel.formatter).toBe('{value}%')
    expect(right.max).toBeUndefined()
    expect((right.axisLabel.formatter as (v: number) => string)(2500)).toBe('2.50s')
  })

  it('tooltip 按系列给单位：百分比带 %、耗时折算 ms/s，null 行不出现', () => {
    const option = qualityTrendOption(trends) as unknown as QualityOptionLike
    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesName: '成功率%', value: 100, marker: '<i></i>' },
      { dataIndex: 0, seriesName: '缓存命中率%', value: 10, marker: '<i></i>' },
      { dataIndex: 0, seriesName: '平均总耗时', value: 4000, marker: '<i></i>' },
      { dataIndex: 0, seriesName: '平均首字耗时', value: 800, marker: '<i></i>' },
    ])
    expect(html).toContain('100%')
    expect(html).toContain('10%')
    expect(html).toContain('4.00s')
    expect(html).toContain('800ms')
    expect(html).toContain('2026-10-27')

    // 整桶无调用（全 null）时只剩日期，不渲染空行
    const nullOnly = option.tooltip.formatter([
      { dataIndex: 1, seriesName: '成功率%', value: null, marker: '<i></i>' },
      { dataIndex: 1, seriesName: '平均总耗时', value: null, marker: '<i></i>' },
    ])
    expect(nullOnly).toBe('2026-10-28')
  })
})

interface QualityOptionLike {
  series: Array<{ name: string; yAxisIndex?: number; lineStyle?: { type?: string }; data: unknown[] }>
  yAxis: Array<{ max?: number; axisLabel: { formatter: unknown } }>
  tooltip: { formatter: (params: unknown) => string }
}

describe('trafficTrendOption', () => {
  const trends: TrendPoint[] = [
    {
      date: '2026-10-27T09:00:00',
      sessions: 1,
      messages: 180,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0
    },
    {
      date: '2026-10-27T10:00:00',
      sessions: 0,
      messages: 40,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0
    }
  ]

  it('会话走左轴实线，消息走右轴虚线，两轴都不设 max 各自缩放', () => {
    const option = trafficTrendOption(trends) as unknown as QualityOptionLike
    const series = option.series
    expect(series.map((s) => s.name)).toEqual(['会话', '消息'])
    expect(series[0].yAxisIndex == null).toBe(true)
    expect(series[0].lineStyle?.type).toBeUndefined()
    expect(series[1].yAxisIndex).toBe(1)
    expect(series[1].lineStyle?.type).toBe('dashed')
    expect(series[0].data).toEqual([1, 0])
    expect(series[1].data).toEqual([180, 40])
    // 量级差一个数量级时同轴会互相压扁，左右轴都不设 max，按各自量级自动缩放
    const [left, right] = option.yAxis
    expect(left.max).toBeUndefined()
    expect(right.max).toBeUndefined()
  })

  it('tooltip 两行都给原始计数值', () => {
    const option = trafficTrendOption(trends) as unknown as QualityOptionLike
    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesName: '会话', value: 1, marker: '<i></i>' },
      { dataIndex: 0, seriesName: '消息', value: 180, marker: '<i></i>' }
    ])
    expect(html).toContain('2026-10-27T09:00:00')
    expect(html).toContain('会话')
    expect(html).toContain('180')
  })
})

describe('costTrendOption', () => {
  const trends: TrendPoint[] = [
    {
      date: '2026-10-27',
      sessions: 1,
      messages: 2,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0,
      cost: 3.2,
      callTokens: 1500,
      costPerMTokens: 2133.33,
    },
    {
      date: '2026-10-28',
      sessions: 0,
      messages: 0,
      chatTokens: 0,
      backgroundTokens: 0,
      totalTokens: 0,
      backgroundCalls: 0,
      cost: 0,
      callTokens: 0,
      costPerMTokens: null,
    },
  ]

  it('两条线：成本合计走左轴，每百万 Token 平均成本挂右轴并用虚线区分', () => {
    const option = costTrendOption(trends) as unknown as QualityOptionLike
    const series = option.series
    expect(series.map((s) => s.name)).toEqual(['成本', '每百万Token平均成本'])
    expect(series[0].yAxisIndex == null).toBe(true)
    expect(series[1].yAxisIndex).toBe(1)
    expect(series[1].lineStyle?.type).toBe('dashed')
    expect(series[1].data).toEqual([2133.33, null])
    // 两条线量级不同（合计 vs 每百万 Token），左右轴都不设 max，各自自动缩放
    const [left, right] = option.yAxis
    expect(left.max).toBeUndefined()
    expect(right.max).toBeUndefined()
    expect((right.axisLabel.formatter as (v: number) => string)(2133.33)).toBe('2,133.3')
  })

  it('tooltip 按成本格式化：0 是有效值照常展示，无分母的 null 行不出现', () => {
    const option = costTrendOption(trends) as unknown as QualityOptionLike
    const html = option.tooltip.formatter([
      { dataIndex: 0, seriesName: '成本', value: 3.2, marker: '<i></i>' },
      { dataIndex: 0, seriesName: '每百万Token平均成本', value: 2133.33, marker: '<i></i>' },
    ])
    expect(html).toContain('3.2')
    expect(html).toContain('2,133.3')
    expect(html).toContain('2026-10-27')

    // 成本 0（模型未配价格）是有效值；每百万 Token 分母为 0 时后端给 null，不出行
    const nullOnly = option.tooltip.formatter([
      { dataIndex: 1, seriesName: '成本', value: 0, marker: '<i></i>' },
      { dataIndex: 1, seriesName: '每百万Token平均成本', value: null, marker: '<i></i>' },
    ])
    expect(nullOnly).toContain('2026-10-28')
    expect(nullOnly).not.toContain('每百万Token平均成本')
  })
})
