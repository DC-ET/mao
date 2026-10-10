<template>
  <BaseChart :option="chartOption" :empty="!hasData" :height="280" empty-text="暂无用量数据" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '../../utils/theme'
import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'
import { formatCost, formatNumber, formatPercentValue, formatToken } from '../../utils/usageFormat'
import BaseChart from '../common/BaseChart.vue'
import { PIE_LABEL_MIN_PERCENT, pieSlicePercents, type PieSlice } from './pie-series'

const props = defineProps<{ slices: PieSlice[] }>()

const { isDark } = useTheme()

const hasData = computed(() => props.slices.length > 0)
const percents = computed(() => pieSlicePercents(props.slices))

/** 主题随 isDark 重算：文字/网格/tooltip 底色/扇区描边（描边取面板底色，暗色下不糊）两套配色。 */
const chartOption = computed<ChartOption>(() => {
  const textColor = isDark.value ? '#a1a1a6' : '#86868b'
  const tooltipBg = isDark.value ? '#2a2a2e' : '#ffffff'
  const tooltipBorder = isDark.value ? '#3a3a3e' : '#e5e5ea'
  const tooltipText = isDark.value ? '#f5f5f7' : '#1d1d1f'
  const sliceBorder = isDark.value ? '#252525' : '#ffffff'
  return {
    color: CHART_PALETTE,
    tooltip: {
      trigger: 'item',
      backgroundColor: tooltipBg,
      borderColor: tooltipBorder,
      textStyle: { color: tooltipText, fontSize: 12 },
      formatter: (params: unknown) => {
        const i = (params as { dataIndex: number }).dataIndex
        const slice = props.slices[i]
        if (!slice) return ''
        const lines = [
          slice.name,
          `调用：${formatNumber(slice.calls)} 次（${formatPercentValue(percents.value[i] ?? 0)}）`,
          `Token：${formatToken(slice.tokens)}`,
        ]
        if (slice.cost != null) lines.push(`成本：${formatCost(slice.cost)}`)
        return lines.join('<br/>')
      },
    },
    legend: {
      // 片数上限 9，窄屏放不下时翻页，不挤压饼图；占比写进图例，细片的百分比也有处可看
      type: 'scroll',
      bottom: 0,
      // 窄屏下图例项之间容易糊成一团：项间距放宽，文字与色块之间也留出距离
      itemGap: 14,
      itemWidth: 14,
      itemHeight: 8,
      textStyle: { color: textColor, fontSize: 11 },
      pageIconColor: textColor,
      pageIconInactiveColor: 'rgba(134,134,139,0.4)',
      pageTextStyle: { color: textColor },
      // 名称与占比之间用全角空格分隔：半角空格在 11px 下几乎看不出，中文名与数字会贴在一起
      formatter: (name: string) => {
        const i = props.slices.findIndex((s) => s.name === name)
        return i < 0 ? name : `${name}　${formatPercentValue(percents.value[i] ?? 0)}`
      },
    },
    series: [
      {
        name: '调用次数',
        type: 'pie',
        radius: ['42%', '70%'],
        center: ['50%', '43%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: sliceBorder, borderWidth: 1 },
        label: {
          color: textColor,
          fontSize: 11,
          formatter: (params: unknown) => `${formatPercentValue((params as { percent: number }).percent)}`,
        },
        labelLine: { length: 8, length2: 6 },
        // 细片不贴标签，连引出线一起关：空标签的引出线 echarts 照画，会戳向空白处
        data: props.slices.map((s, i) => ({
          name: s.name,
          value: s.value,
          label: { show: percents.value[i] >= PIE_LABEL_MIN_PERCENT },
          labelLine: { show: percents.value[i] >= PIE_LABEL_MIN_PERCENT },
        })),
      },
    ],
  }
})
</script>
