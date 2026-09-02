<template>
  <div class="chart-box" :style="{ height: `${height}px` }">
    <div v-if="empty" class="chart-empty">
      <el-empty :description="emptyText" :image-size="60" />
    </div>
    <div v-else ref="el" class="chart-canvas" />
  </div>
</template>

<script setup lang="ts">
import { nextTick, onActivated, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { echarts, type ChartOption } from '../utils/echarts'

const props = withDefaults(
  defineProps<{
    option: ChartOption
    height?: number
    empty?: boolean
    emptyText?: string
  }>(),
  { height: 280, empty: false, emptyText: '暂无数据' }
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let observer: ResizeObserver | null = null

function render() {
  if (!el.value) return
  chart = chart ?? echarts.init(el.value)
  // notMerge：切换周期后系列数量可能变化，合并会残留旧系列
  chart.setOption(props.option, true)
}

function observe() {
  if (!el.value || observer) return
  observer = new ResizeObserver(() => chart?.resize())
  observer.observe(el.value)
}

function dispose() {
  observer?.disconnect()
  observer = null
  chart?.dispose()
  chart = null
}

onMounted(() => {
  render()
  observe()
})

// keep-alive 切回时容器尺寸可能刚恢复，需要主动 resize 一次
onActivated(() => chart?.resize())

onBeforeUnmount(dispose)

watch(() => props.option, render, { deep: true })

// empty 切换会销毁/重建 DOM 节点，需要在下一帧重新初始化
watch(
  () => props.empty,
  async (isEmpty) => {
    if (isEmpty) {
      dispose()
      return
    }
    await nextTick()
    render()
    observe()
  }
)
</script>

<style scoped>
.chart-box {
  width: 100%;
}

.chart-canvas,
.chart-empty {
  width: 100%;
  height: 100%;
}

.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
