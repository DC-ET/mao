<template>
  <!-- 只在调用方判定「执行中」后挂载：起表即开始走表，工具结束/卸载即停，不常驻定时器 -->
  <span v-if="startedAtMs != null" class="tool-elapsed">{{ elapsedText }}</span>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { formatElapsedMs } from '../../utils/elapsed'

const props = defineProps<{
  /** 起表时刻（epoch ms）；缺省时不渲染（调用方均已 v-if 守门，这里双保险） */
  startedAtMs?: number
}>()

// 秒级走表：duration 要等工具结束才知道，执行中「卡了多久」只能靠客户端时钟回答
// （与 RunTracePanel 轨迹 tab 的 live 计时同口径）。Date.now() 取差值，定时器被浏览器
// 节流后恢复时会自动追平，不会越走越慢。
const nowTick = ref(Date.now())
const timer = props.startedAtMs == null
  ? null
  : window.setInterval(() => { nowTick.value = Date.now() }, 1000)
onUnmounted(() => {
  if (timer != null) window.clearInterval(timer)
})

const elapsedText = computed(() =>
  props.startedAtMs == null ? '' : formatElapsedMs(nowTick.value - props.startedAtMs))
</script>

<style scoped>
.tool-elapsed {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  /* 等宽数字：秒级跳变时宽度不抖，右侧 spinner 不跟着晃 */
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
