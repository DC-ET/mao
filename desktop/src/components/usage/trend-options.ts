import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'

/** 三张趋势图取色：Token 蓝、请求数绿、缓存命中率紫、成本橙。 */
export const TREND_COLORS = {
  token: CHART_PALETTE[0],
  calls: CHART_PALETTE[1],
  cost: CHART_PALETTE[2],
  hitRate: CHART_PALETTE[3],
} as const

export interface TrendLine {
  name: string
  /** 与 labels 等长；null 处折线断开（如无调用的桶不参与命中率） */
  data: Array<number | null>
  color: string
  /** 双轴图里命中右轴（请求数 / 缓存命中率） */
  right?: boolean
  /** tooltip 读数；缺省用所在轴的轴标签格式 */
  tooltipFormat?: (value: number) => string
}

export interface TrendAxisFormat {
  name?: string
  format: (value: number) => string
}

export interface TrendLineConfig {
  labels: string[]
  lines: TrendLine[]
  leftAxis: TrendAxisFormat
  /** 右轴：仅双轴图（单位不同的两条线）传 */
  rightAxis?: TrendAxisFormat
  /** tooltip 每条桶下方的补充行（失败次数等），空串行忽略 */
  tooltipExtra?: (dataIndex: number) => string[]
  isDark: boolean
}

/** 折线图 option 构建（纯函数，便于单测）：主题配色、双轴、tooltip 读数都在这里收口。 */
export function buildTrendLineOption(config: TrendLineConfig): ChartOption {
  const axisColor = config.isDark ? '#a1a1a6' : '#86868b'
  const splitLine = config.isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  const tooltipBg = config.isDark ? '#2a2a2e' : '#ffffff'
  const tooltipBorder = config.isDark ? '#3a3a3e' : '#e5e5ea'
  const tooltipText = config.isDark ? '#f5f5f7' : '#1d1d1f'
  const axisFormat = (line: TrendLine) =>
    (line.right ? config.rightAxis?.format : undefined) ?? config.leftAxis.format
  const withLegend = config.lines.length > 1
  return {
    tooltip: {
      trigger: 'axis',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 12 },
      formatter: (params: unknown) => {
        const list = (Array.isArray(params) ? params : [params]) as Array<{ dataIndex: number }>
        if (list.length === 0) return ''
        const i = list[0].dataIndex
        const rows = [config.labels[i] ?? '']
        for (const line of config.lines) {
          const v = line.data[i]
          const fmt = line.tooltipFormat ?? axisFormat(line)
          rows.push(`${line.name}：${v == null ? '-' : fmt(v)}`)
        }
        if (config.tooltipExtra) rows.push(...config.tooltipExtra(i).filter((row) => row.length > 0))
        return rows.join('<br/>')
      },
    },
    legend: {
      show: withLegend,
      data: config.lines.map((l) => l.name),
      textStyle: { color: axisColor, fontSize: 12 },
      top: 0,
    },
    grid: { left: 8, right: 12, top: withLegend ? 32 : 8, bottom: 4, containLabel: true },
    xAxis: {
      type: 'category',
      data: config.labels,
      axisLabel: { color: axisColor, fontSize: 11 },
      axisLine: { lineStyle: { color: splitLine } },
    },
    yAxis: [
      {
        type: 'value',
        name: config.leftAxis.name,
        nameTextStyle: { color: axisColor },
        axisLabel: { color: axisColor, fontSize: 11, formatter: (v: number) => config.leftAxis.format(v) },
        splitLine: { lineStyle: { color: splitLine } },
      },
      ...(config.rightAxis
        ? [{
            type: 'value' as const,
            name: config.rightAxis.name,
            nameTextStyle: { color: axisColor },
            axisLabel: { color: axisColor, fontSize: 11, formatter: (v: number) => config.rightAxis!.format(v) },
            splitLine: { show: false },
          }]
        : []),
    ],
    series: config.lines.map((line) => ({
      name: line.name,
      type: 'line' as const,
      yAxisIndex: line.right ? 1 : 0,
      data: line.data,
      itemStyle: { color: line.color },
      lineStyle: { width: 1.5 },
      symbol: 'circle',
      symbolSize: 4,
      smooth: false,
    })),
  }
}
