/**
 * ECharts 按需注册：只引入「我的用量」趋势图所需的图表与组件，避免全量包体。
 * 新增图表类型时在此处补 use()，不要在业务组件里直接 import 'echarts'。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  TooltipComponent
} from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import { CanvasRenderer } from 'echarts/renderers'
import type { ComposeOption } from 'echarts/core'
import type { BarSeriesOption, LineSeriesOption } from 'echarts/charts'
import type {
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption
} from 'echarts/components'

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  LabelLayout,
  CanvasRenderer
])

export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
>

/** 与管理后台一致的主色板；趋势图的 Token 柱与成本线各取一色。 */
export const CHART_PALETTE = [
  '#0066cc',
  '#34c759',
  '#ff9500',
  '#af52de',
  '#5ac8fa',
  '#ff3b30',
  '#ffcc00',
  '#5856d6',
  '#00c7be',
  '#a2845e'
]

export { echarts }
