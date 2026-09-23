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
  callCount?: number
  callFailCount?: number
  callTokens?: number
  promptTokens?: number
  cachedTokens?: number
  callSuccessRate?: number | null
  cacheHitRate?: number | null
}

export interface RankItem {
  name: string
  value: number
  color?: string
}

/** ECharts tooltip formatter 返回值按 HTML 渲染，模型/用户/Agent 等名称必须转义后拼接。 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatNumber(value: number): string {
  return value.toLocaleString('zh-CN')
}

/** 计数类大数用中文万/亿，避免坐标轴与卡片被长数字撑开。 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e8) return `${trimZero(value / 1e8)} 亿`
  if (abs >= 1e4) return `${trimZero(value / 1e4)} 万`
  return String(value)
}

/** Token 紧凑单位按业界惯例：K=千、M=百万、B=十亿。 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${trimZero(value / 1e9)}B`
  if (abs >= 1e6) return `${trimZero(value / 1e6)}M`
  if (abs >= 1e3) return `${trimZero(value / 1e3)}K`
  return String(value)
}

function trimZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

/** 阶段配色按枚举绑定，零值阶段被过滤后颜色不会错位。图表与会话 Tab 的 live 标签共用。 */
export const PHASE_COLORS: Record<string, string> = {
  IDLE: '#6e6e73',
  RUNNING: '#0066cc',
  RESUMING: '#5ac8fa',
  WAITING_APPROVAL: '#b25000',
  COMPLETED: '#34c759',
  FAILED: '#d70015',
  CANCELLED: '#8e8e93'
}

export function phaseColor(phase: string): string {
  return PHASE_COLORS[phase] || '#6e6e73'
}

/* ---- 图表配色从 CSS 变量读取，与页面主题保持一致 ---- */

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export const AXIS_LABEL_COLOR = () => cssVar('--mao-muted', '#6e6e73')
export const SPLIT_LINE_COLOR = () => cssVar('--mao-border', 'rgba(0, 0, 0, 0.06)')
export const INK_COLOR = () => cssVar('--mao-ink', '#1d1d1f')
export const SURFACE_COLOR = () => cssVar('--mao-surface', '#ffffff')

export function isHourlyTrendDate(date: string): boolean {
  return date.includes(':')
}

/** 单日按小时只标 HH:mm；跨天小时标 MM-DD HH:mm；按天标 MM-DD。 */
export function trendCategoryLabels(dates: string[]): string[] {
  const hourly = dates.some(isHourlyTrendDate)
  const singleDay = hourly && new Set(dates.map((date) => date.slice(0, 10))).size <= 1
  return dates.map((date) => {
    if (!hourly) return date.slice(5, 10)
    if (singleDay) return date.slice(11, 16)
    return `${date.slice(5, 10)} ${date.slice(11, 16)}`
  })
}

const baseGrid = { left: 8, right: 8, bottom: 4, top: 32, containLabel: true }

function categoryAxis(dates: string[]) {
  return {
    type: 'category' as const,
    data: trendCategoryLabels(dates),
    boundaryGap: false,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: SPLIT_LINE_COLOR() } },
    axisLabel: { color: AXIS_LABEL_COLOR(), fontSize: 11, hideOverlap: true }
  }
}

function valueAxis(name: string, format: (v: number) => string = formatCompact) {
  return {
    type: 'value' as const,
    name,
    nameTextStyle: { color: AXIS_LABEL_COLOR(), fontSize: 11 },
    splitLine: { lineStyle: { color: SPLIT_LINE_COLOR() } },
    axisLabel: { color: AXIS_LABEL_COLOR(), fontSize: 11, formatter: (v: number) => format(v) }
  }
}

/** 图例居中，避开左右两侧的坐标轴名称。 */
export const trendLegend = {
  top: 0,
  left: 'center' as const,
  icon: 'roundRect',
  itemWidth: 10,
  itemHeight: 10,
  textStyle: { fontSize: 12 }
}

/** 按天超过 30 天聚焦最近 30 天；按小时超过 48 小时聚焦最近 48 小时。 */
export function trendDataZoom(count: number, hourly: boolean) {
  const windowSize = hourly ? 48 : 30
  if (count <= windowSize) return undefined
  const start = Math.max(0, 100 - (windowSize / count) * 100)
  return [
    { type: 'inside' as const, start, end: 100 },
    { type: 'slider' as const, height: 16, bottom: 0, start, end: 100 }
  ]
}

export interface SingleSeriesSpec {
  key: 'sessions' | 'messages'
  name: string
  color: string
}

/** 单序列小多图：避免双 y 轴把不同单位的序列画在一起。 */
export function seriesTrendOption(trends: TrendPoint[], specs: SingleSeriesSpec[]): ChartOption {
  const dates = trends.map((t) => t.date)
  const hourly = dates.some(isHourlyTrendDate)
  const zoom = trendDataZoom(trends.length, hourly)
  return {
    color: specs.map((s) => s.color),
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line' },
      formatter: (params: unknown) => tooltipRows(params as TooltipParam[], dates)
    },
    grid: { ...baseGrid, bottom: zoom ? 28 : 4 },
    dataZoom: zoom,
    xAxis: categoryAxis(dates),
    yAxis: valueAxis(''),
    series: specs.map((spec) => ({
      name: spec.name,
      type: 'line' as const,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      showSymbol: trends.length <= 31,
      lineStyle: { width: 2.5 },
      areaStyle: { opacity: 0.12 },
      itemStyle: { color: spec.color },
      data: trends.map((t) => t[spec.key])
    }))
  }
}

/** Token 堆叠柱状图：对话 Token + 后台调用 Token。 */
export function tokenTrendOption(trends: TrendPoint[]): ChartOption {
  const dates = trends.map((t) => t.date)
  const hourly = dates.some(isHourlyTrendDate)
  const zoom = trendDataZoom(trends.length, hourly)
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
    yAxis: valueAxis('Token', formatTokens),
    series: [
      {
        name: '对话 Token',
        type: 'bar',
        stack: 'token',
        barMaxWidth: 26,
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
    .map((p) => `${p.marker}${escapeHtml(p.seriesName)}<span style="float:right;margin-left:16px;font-weight:600">${formatNumber(p.value ?? 0)}</span>`)
    .join('<br/>')
  const total = withTotal && params.length > 1
    ? `<br/>合计<span style="float:right;margin-left:16px;font-weight:600">${formatNumber(params.reduce((s, p) => s + (p.value ?? 0), 0))}</span>`
    : ''
  return `<div style="min-width:150px"><div style="margin-bottom:4px;color:#6e6e73">${escapeHtml(date)}</div>${rows}${total}</div>`
}

/** 环形图：中心显示主指标，legend 右侧竖排；item.color 优先，否则按调色板顺序取色。 */
export function donutOption(items: RankItem[], centerLabel: string, centerValue: string): ChartOption {
  return {
    color: CHART_PALETTE,
    tooltip: {
      trigger: 'item',
      formatter: (p: unknown) => {
        const param = p as { marker: string; name: string; value: number; percent: number }
        return `${param.marker}${escapeHtml(param.name)}<br/><b>${formatNumber(param.value)}</b>（${param.percent}%）`
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
      textStyle: { fontSize: 12, color: AXIS_LABEL_COLOR() },
      // legend 是纯文本渲染，但保持统一截断口径；不需要 HTML 转义
      formatter: (name: string) => (name.length > 12 ? `${name.slice(0, 12)}…` : name)
    },
    series: [
      {
        type: 'pie',
        radius: ['55%', '78%'],
        center: ['36%', '50%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: SURFACE_COLOR(), borderWidth: 2 },
        label: {
          show: true,
          position: 'center',
          formatter: () => `{v|${centerValue}}\n{l|${centerLabel}}`,
          rich: {
            v: { fontSize: 20, fontWeight: 'bold', color: INK_COLOR(), lineHeight: 28 },
            l: { fontSize: 12, color: AXIS_LABEL_COLOR() }
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

/** 横向条形排行：名称在左，数值贴条尾。Token 排行传 formatTokens。 */
export function rankBarOption(
  items: RankItem[],
  color: string,
  format: (v: number) => string = formatCompact
): ChartOption {
  const ordered = [...items].reverse()
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const list = params as TooltipParam[]
        return list.length > 0
          ? `${escapeHtml(ordered[list[0].dataIndex]?.name ?? '')}<br/><b>${formatNumber(list[0].value ?? 0)}</b>`
          : ''
      }
    },
    grid: { left: 8, right: 56, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: SPLIT_LINE_COLOR() } }, axisLabel: { show: false } },
    yAxis: {
      type: 'category',
      data: ordered.map((item) => (item.name.length > 14 ? `${item.name.slice(0, 14)}…` : item.name)),
      axisTick: { show: false },
      axisLine: { show: false },
      axisLabel: { color: AXIS_LABEL_COLOR(), fontSize: 12 }
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
          color: AXIS_LABEL_COLOR(),
          formatter: (p: unknown) => format((p as { value: number }).value)
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
  // 「其他」固定中性灰：Top N 已用完 10 色调色板，循环取色会与最大项撞色
  return rest > 0 ? [...sorted.slice(0, top), { name: '其他', value: rest, color: '#c7c7cc' }] : sorted.slice(0, top)
}
