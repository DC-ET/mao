import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'
import { phaseLabel } from '../../utils/labels'

export interface TrendPoint {
  date: string
  sessions: number
  messages: number
  chatTokens: number
  backgroundTokens: number
  totalTokens: number
  backgroundCalls: number
}

export interface RankItem {
  name: string
  value: number
  color?: string
}

const AXIS_LABEL_COLOR = '#86868b'
const SPLIT_LINE_COLOR = 'rgba(0, 0, 0, 0.06)'

/** 阶段配色按枚举绑定，零值阶段被过滤后颜色不会错位。 */
const PHASE_COLORS: Record<string, string> = {
  IDLE: '#8e8e93',
  RUNNING: '#0066cc',
  RESUMING: '#5ac8fa',
  WAITING_APPROVAL: '#ff9500',
  COMPLETED: '#34c759',
  FAILED: '#ff3b30',
  CANCELLED: '#c7c7cc'
}

/** 大数用中文万/亿，避免坐标轴与卡片被长数字撑开。 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trimZero(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trimZero(value / 1e4)} 万`
  return String(value)
}

export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

function mmdd(date: string): string {
  return date.slice(5)
}

const baseGrid = { left: 8, right: 8, bottom: 4, top: 32, containLabel: true }

function categoryAxis(dates: string[]) {
  return {
    type: 'category' as const,
    data: dates.map(mmdd),
    boundaryGap: false,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: SPLIT_LINE_COLOR } },
    axisLabel: { color: AXIS_LABEL_COLOR, fontSize: 11, hideOverlap: true }
  }
}

function valueAxis(name: string) {
  return {
    type: 'value' as const,
    name,
    nameTextStyle: { color: AXIS_LABEL_COLOR, fontSize: 11 },
    splitLine: { lineStyle: { color: SPLIT_LINE_COLOR } },
    axisLabel: { color: AXIS_LABEL_COLOR, fontSize: 11, formatter: (v: number) => formatCompact(v) }
  }
}

/** 图例居中，避开左右两侧的坐标轴名称。 */
const trendLegend = {
  top: 0,
  left: 'center' as const,
  icon: 'roundRect',
  itemWidth: 10,
  itemHeight: 10,
  textStyle: { fontSize: 12 }
}

/** 天数较多时默认聚焦最近 30 天，仍可拖动查看全周期。 */
function dataZoom(days: number) {
  if (days <= 30) return undefined
  return [
    { type: 'inside' as const, start: Math.max(0, 100 - (30 / days) * 100), end: 100 },
    { type: 'slider' as const, height: 16, bottom: 0, start: Math.max(0, 100 - (30 / days) * 100), end: 100 }
  ]
}

export function trafficTrendOption(trends: TrendPoint[]): ChartOption {
  const dates = trends.map((t) => t.date)
  const zoom = dataZoom(trends.length)
  return {
    color: [CHART_PALETTE[0], CHART_PALETTE[1]],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params: unknown) => tooltipRows(params as TooltipParam[], dates)
    },
    legend: trendLegend,
    grid: { ...baseGrid, bottom: zoom ? 28 : 4 },
    dataZoom: zoom,
    xAxis: categoryAxis(dates),
    yAxis: [valueAxis('会话'), valueAxis('消息')],
    series: [
      {
        name: '会话',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: trends.length <= 31,
        lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 },
        data: trends.map((t) => t.sessions)
      },
      {
        name: '消息',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: trends.length <= 31,
        lineStyle: { width: 2.5 },
        data: trends.map((t) => t.messages)
      }
    ]
  }
}

export function tokenTrendOption(trends: TrendPoint[]): ChartOption {
  const dates = trends.map((t) => t.date)
  const zoom = dataZoom(trends.length)
  return {
    color: [CHART_PALETTE[0], CHART_PALETTE[2]],
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => tooltipRows(params as TooltipParam[], dates, true)
    },
    legend: trendLegend,
    grid: { ...baseGrid, bottom: zoom ? 28 : 4 },
    dataZoom: zoom,
    xAxis: { ...categoryAxis(dates), boundaryGap: true },
    yAxis: valueAxis('Token'),
    series: [
      {
        name: '对话 Token',
        type: 'bar',
        stack: 'token',
        barMaxWidth: 26,
        itemStyle: { borderRadius: [0, 0, 0, 0] },
        data: trends.map((t) => t.chatTokens)
      },
      {
        name: '后台 Token',
        type: 'bar',
        stack: 'token',
        barMaxWidth: 26,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: trends.map((t) => t.backgroundTokens)
      }
    ]
  }
}

interface TooltipParam {
  dataIndex: number
  seriesName: string
  value: number
  marker: string
}

function tooltipRows(params: TooltipParam[], dates: string[], withTotal = false): string {
  if (params.length === 0) return ''
  const date = dates[params[0].dataIndex] ?? ''
  const rows = params
    .map((p) => `${p.marker}${p.seriesName}<span style="float:right;margin-left:16px;font-weight:600">${formatNumber(p.value ?? 0)}</span>`)
    .join('<br/>')
  const total = withTotal && params.length > 1
    ? `<br/>合计<span style="float:right;margin-left:16px;font-weight:600">${formatNumber(params.reduce((s, p) => s + (p.value ?? 0), 0))}</span>`
    : ''
  return `<div style="min-width:150px"><div style="margin-bottom:4px;color:#86868b">${date}</div>${rows}${total}</div>`
}

/** 环形图：中心显示主指标，legend 右侧竖排；item.color 优先，否则按调色板顺序取色。 */
export function donutOption(items: RankItem[], centerLabel: string, centerValue: string): ChartOption {
  return {
    color: CHART_PALETTE,
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const param = p as { marker: string; name: string; value: number; percent: number }
        return `${param.marker}${param.name}<br/><b>${formatNumber(param.value)}</b>（${param.percent}%）`
      }
    },
    legend: {
      type: 'scroll',
      orient: 'vertical',
      right: 0,
      top: 'middle',
      itemWidth: 10,
      itemHeight: 10,
      icon: 'roundRect',
      textStyle: { fontSize: 12, color: AXIS_LABEL_COLOR },
      formatter: (name: string) => (name.length > 12 ? `${name.slice(0, 12)}…` : name)
    },
    series: [
      {
        type: 'pie',
        radius: ['55%', '78%'],
        center: ['36%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#fff', borderWidth: 2 },
        label: {
          show: true,
          position: 'center',
          formatter: () => `{v|${centerValue}}\n{l|${centerLabel}}`,
          rich: {
            v: { fontSize: 20, fontWeight: 'bold', color: '#1d1d1f', lineHeight: 28 },
            l: { fontSize: 12, color: AXIS_LABEL_COLOR }
          }
        },
        emphasis: { label: { show: true }, scaleSize: 6 },
        labelLine: { show: false },
        data: items.map((item) => ({
          name: item.name,
          value: item.value,
          itemStyle: item.color ? { color: item.color } : undefined
        }))
      }
    ]
  }
}

/** 横向条形排行：名称在左，数值贴条尾。 */
export function rankBarOption(items: RankItem[], color: string): ChartOption {
  const ordered = [...items].reverse()
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as TooltipParam[]
        return list.length > 0 ? `${ordered[list[0].dataIndex]?.name ?? ''}<br/><b>${formatNumber(list[0].value ?? 0)}</b>` : ''
      }
    },
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: SPLIT_LINE_COLOR } }, axisLabel: { show: false } },
    yAxis: {
      type: 'category',
      data: ordered.map((item) => (item.name.length > 14 ? `${item.name.slice(0, 14)}…` : item.name)),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: AXIS_LABEL_COLOR, fontSize: 12 }
    },
    series: [
      {
        type: 'bar',
        barMaxWidth: 16,
        itemStyle: { color, borderRadius: [0, 4, 4, 0] },
        label: {
          show: true,
          position: 'right',
          fontSize: 11,
          color: AXIS_LABEL_COLOR,
          formatter: (p: unknown) => formatCompact((p as { value: number }).value)
        },
        data: ordered.map((item) => item.value)
      }
    ]
  }
}

/** KPI 卡片内的迷你走势，无坐标轴与交互。 */
export function sparklineOption(values: number[], color: string): ChartOption {
  return {
    grid: { left: 0, right: 0, top: 4, bottom: 0 },
    xAxis: { type: 'category', show: false, boundaryGap: false, data: values.map((_, i) => i) },
    yAxis: { type: 'value', show: false, min: 0 },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'none',
        silent: true,
        lineStyle: { width: 2, color },
        areaStyle: { color, opacity: 0.14 },
        data: values
      }
    ]
  }
}

export function phaseRankItems(rows: Array<{ phase: string; count: number }>): RankItem[] {
  return rows
    .filter((row) => Number(row.count) > 0)
    .map((row) => ({ name: phaseLabel(row.phase), value: Number(row.count), color: PHASE_COLORS[row.phase] }))
}

/** 占比图只保留 Top N，其余合并为「其他」，避免长尾把 legend 撑爆。 */
export function topWithOthers(items: RankItem[], top: number): RankItem[] {
  const sorted = [...items].filter((item) => item.value > 0).sort((a, b) => b.value - a.value)
  if (sorted.length <= top) return sorted
  const rest = sorted.slice(top).reduce((sum, item) => sum + item.value, 0)
  return rest > 0 ? [...sorted.slice(0, top), { name: '其他', value: rest }] : sorted.slice(0, top)
}
