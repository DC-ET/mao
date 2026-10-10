<template>
  <BaseChart :option="chartOption" :empty="!hasData" :height="280" empty-text="暂无用量数据" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTheme } from '../../utils/theme'
import { CHART_PALETTE, type ChartOption } from '../../utils/echarts'
import { formatCost, formatNumber, formatToken } from '../../utils/usageFormat'
import BaseChart from '../common/BaseChart.vue'
import type { PieSlice } from './pie-series'

const props = defineProps<{ slices: PieSlice[] }>()

const { isDark } = useTheme()

const hasData = computed(() => props.slices.length > 0)
const total = computed(() => props.slices.reduce((sum, s) => sum + s.value, 0))

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
        const pct = total.value > 0 ? Math.round((slice.value / total.value) * 100) : 0
        const lines = [
          slice.name,
          `调用：${formatNumber(slice.calls)} 次（${pct}%）`,
          `Token：${formatToken(slice.tokens)}`,
        ]
        if (slice.cost != null) lines.push(`成本：${formatCost(slice.cost)}`)
        return lines.join('<br/>')
      },
    },
    legend: {
      // 片数上限 9，窄屏放不下时翻页，不挤压饼图
      type: 'scroll',
      bottom: 0,
      textStyle: { color: textColor, fontSize: 11 },
      pageIconColor: textColor,
      pageIconInactiveColor: 'rgba(134,134,139,0.4)',
      pageTextStyle: { color: textColor },
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
          // 小片区不强行贴百分比，交给图例与 tooltip
          formatter: (params: unknown) => {
            const percent = (params as { percent: number }).percent
            return percent >= 8 ? `${Math.round(percent)}%` : ''
          },
        },
        labelLine: { length: 8, length2: 6 },
        data: props.slices.map((s) => ({ name: s.name, value: s.value })),
      },
    ],
  }
})
</script>
