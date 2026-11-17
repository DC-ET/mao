import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'
import { formatPercent } from './hostFormat'

/** 页面打开期间的采样间隔。 */
export const HOST_TREND_INTERVAL_MS = 1000
/** 只留最近 5 分钟，更早的点丢掉。不写入本地或数据库。 */
export const HOST_TREND_WINDOW_MS = 5 * 60 * 1000

export interface HostTrendPoint {
  at: number
  cpu: number | null
  memory: number
}

/** 按时间并入一个点，丢掉窗口之外的旧点。同一时刻后来的覆盖先前的。 */
export function appendHostTrend(
  points: readonly HostTrendPoint[],
  point: HostTrendPoint,
  windowMs = HOST_TREND_WINDOW_MS
): HostTrendPoint[] {
  const newest = Math.max(point.at, points[points.length - 1]?.at ?? point.at)
  const cutoff = newest - windowMs
  const next = points.filter((item) => item.at >= cutoff && item.at !== point.at)
  next.push(point)
  next.sort((a, b) => a.at - b.at)
  return next
}

function clockLabel(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function axisColor(): string {
  if (typeof document === 'undefined') return '#6e6e73'
  return getComputedStyle(document.documentElement).getPropertyValue('--mao-muted').trim() || '#6e6e73'
}

function seriesValue(value: unknown): number | null {
  const raw = Array.isArray(value) ? value[1] : value
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
}

/** 一张图只画一个指标。纵轴 0–100%，横轴是采样时刻，离开页面造成的空隙会留在图上。 */
export function hostTrendOption(points: readonly HostTrendPoint[], field: 'cpu' | 'memory'): ChartOption {
  const newest = points[points.length - 1]?.at ?? 0
  const oldest = points[0]?.at ?? newest
  const span = Math.max(newest - oldest, 1000)
  const name = field === 'cpu' ? 'CPU' : '内存'
  return {
    color: [field === 'cpu' ? CHART_PALETTE[0] : CHART_PALETTE[1]],
    animationDuration: 200,
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as Array<{
          axisValue?: string | number
          value?: unknown
        }>
        const at = Number(rows[0]?.axisValue)
        const title = Number.isFinite(at) ? clockLabel(at) : ''
        return `${title}<br/>${name} ${formatPercent(seriesValue(rows[0]?.value))}`
      }
    },
    grid: { left: 44, right: 12, top: 12, bottom: 24 },
    xAxis: {
      type: 'time',
      min: newest - span,
      max: newest,
      axisLabel: { color: axisColor(), hideOverlap: true, formatter: (value: number) => clockLabel(value) },
      axisTick: { show: false }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: 100,
      axisLabel: { color: axisColor(), formatter: '{value}%' },
      splitLine: { lineStyle: { color: 'rgba(0, 0, 0, 0.06)' } }
    },
    series: [
      {
        name,
        type: 'line',
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: points.length <= 2,
        connectNulls: false,
        lineStyle: { width: 2 },
        areaStyle: { opacity: 0.08 },
        data: points.map((point) => [point.at, point[field]])
      }
    ]
  }
}
