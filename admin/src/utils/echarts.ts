/**
 * ECharts 按需注册：只引入用量分析所需的图表与组件，避免全量包体。
 * 新增图表类型时在此处补 use()，不要在业务组件里直接 import 'echarts'。
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent
} from 'echarts/components'
import { LabelLayout } from 'echarts/features'
import { CanvasRenderer } from 'echarts/renderers'
import type { ComposeOption } from 'echarts/core'
import type { BarSeriesOption, LineSeriesOption, PieSeriesOption } from 'echarts/charts'
import type {
  DataZoomComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TooltipComponentOption
} from 'echarts/components'

echarts.use([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  LabelLayout,
  CanvasRenderer
])

export type ChartOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | DataZoomComponentOption
>

/** 与管理后台主色一致的分类色板；灰色留给「其他」等聚合项，此处不占用。 */
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
