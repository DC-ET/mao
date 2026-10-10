import { describe, expect, it } from 'vitest'
import { buildTrendLineOption, TREND_COLORS, type TrendLineConfig } from './trend-options'

function config(partial: Partial<TrendLineConfig> = {}): TrendLineConfig {
  return {
    labels: ['10-09', '10-10'],
    lines: [{ name: 'Token', data: [1000, 2000], color: TREND_COLORS.token }],
    leftAxis: { name: 'Token', format: (v) => String(v) },
    isDark: false,
    ...partial,
  }
}

/** option 是 compose 联合类型，测试里按结构取值。 */
function optionOf(cfg: TrendLineConfig) {
  return buildTrendLineOption(cfg) as unknown as {
    tooltip: { formatter: (params: unknown) => string }
    legend: { show: boolean; data: string[] }
    grid: { top: number }
    xAxis: { data: string[] }
    yAxis: Array<{ name?: string; axisLabel: { formatter: (v: number) => string }; splitLine: { show?: boolean } }>
    series: Array<{ name: string; type: string; yAxisIndex: number; data: Array<number | null> }>
  }
}

describe('trend-options', () => {
  it('单条折线：不显示图例、grid 顶部收紧，series 走 line 且落在左轴', () => {
    const o = optionOf(config())
    expect(o.legend.show).toBe(false)
    expect(o.grid.top).toBe(8)
    expect(o.xAxis.data).toEqual(['10-09', '10-10'])
    expect(o.yAxis).toHaveLength(1)
    expect(o.yAxis[0].name).toBe('Token')
    expect(o.series).toHaveLength(1)
    expect(o.series[0]).toMatchObject({ name: 'Token', type: 'line', yAxisIndex: 0 })
    expect(o.series[0].data).toEqual([1000, 2000])
  })

  it('双轴：请求数落左轴、命中率落右轴，右轴不出分割线', () => {
    const o = optionOf(config({
      lines: [
        { name: '请求数', data: [3, 0], color: TREND_COLORS.calls },
        { name: '缓存命中率', data: [25, null], color: TREND_COLORS.hitRate, right: true },
      ],
      leftAxis: { name: '请求数', format: (v) => String(v) },
      rightAxis: { name: '命中率', format: (v) => `${v}%` },
    }))
    expect(o.legend.show).toBe(true)
    expect(o.legend.data).toEqual(['请求数', '缓存命中率'])
    expect(o.grid.top).toBe(32)
    expect(o.yAxis).toHaveLength(2)
    expect(o.yAxis[0].name).toBe('请求数')
    expect(o.yAxis[1].name).toBe('命中率')
    expect(o.yAxis[1].axisLabel.formatter(33.3)).toBe('33.3%')
    expect(o.yAxis[1].splitLine.show).toBe(false)
    expect(o.series.map((s) => s.yAxisIndex)).toEqual([0, 1])
    // null 处折线断开，不画到 0
    expect(o.series[1].data).toEqual([25, null])
  })

  it('tooltip：按桶输出标题、各折线读数与补充行', () => {
    const o = optionOf(config({
      lines: [
        { name: '请求数', data: [3, 0], color: TREND_COLORS.calls, tooltipFormat: (v) => `${v} 次` },
        { name: '缓存命中率', data: [25, null], color: TREND_COLORS.hitRate, right: true, tooltipFormat: (v) => `${v}%` },
      ],
      leftAxis: { name: '请求数', format: (v) => String(v) },
      rightAxis: { name: '命中率', format: (v) => `${v}%` },
      tooltipExtra: (i) => (i === 0 ? ['失败 1 次'] : []),
    }))
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toBe('10-09<br/>请求数：3 次<br/>缓存命中率：25%<br/>失败 1 次')
    // null 值显示占位符，无补充行时不输出空行
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).toBe('10-10<br/>请求数：0 次<br/>缓存命中率：-')
    expect(o.tooltip.formatter([])).toBe('')
  })

  it('tooltip 缺省 tooltipFormat 时沿用所在轴的格式', () => {
    const o = optionOf(config({
      leftAxis: { format: (v) => `${v}k` },
    }))
    expect(o.tooltip.formatter([{ dataIndex: 1 }])).toBe('10-10<br/>Token：2000k')
  })

  it('暗色主题切换坐标与 tooltip 配色', () => {
    const light = optionOf(config()) as unknown as { tooltip: { backgroundColor: string } }
    const dark = optionOf(config({ isDark: true })) as unknown as { tooltip: { backgroundColor: string } }
    expect(light.tooltip.backgroundColor).toBe('#ffffff')
    expect(dark.tooltip.backgroundColor).toBe('#2a2a2e')
  })
})
