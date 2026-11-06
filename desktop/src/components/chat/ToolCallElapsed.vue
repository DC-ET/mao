<template>
  <!-- 只在调用方判定「执行中」后挂载：起表即开始走表，工具结束/卸载即停，不常驻定时器。
       不足 1s 不渲染——绝大多数工具调用远小于 1s，一闪而过的 ms 数字只是噪音；
       跨过阈值后才出现，与 spinner 的相对位置一次性落定。 -->
  <span v-if="visible" class="tool-elapsed">{{ elapsedText }}</span>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import { formatElapsedMs } from '../../utils/elapsed'

const props = defineProps<{
  /** 起表时刻（epoch ms）；缺省时不渲染（调用方均已 v-if 守门，这里双保险） */
  startedAtMs?: number
}>()

/** 展示阈值：耗时满 1s 才显示（formatElapsedMs 亦不再有 ms 档） */
const MIN_VISIBLE_MS = 1000

// 秒级走表：duration 要等工具结束才知道，执行中「卡了多久」只能靠客户端时钟回答
// （订阅重放带回的服务端已耗时已由 elapsedBaseMs 换算进 startedAtMs）。Date.now() 取差值，
// 定时器被浏览器节流后恢复时会自动追平，不会越走越慢。
const nowTick = ref(Date.now())
const timer = props.startedAtMs == null
  ? null
  : window.setInterval(() => { nowTick.value = Date.now() }, 1000)
onUnmounted(() => {
  if (timer != null) window.clearInterval(timer)
})

const elapsedMs = computed(() =>
  props.startedAtMs == null ? 0 : Math.max(0, nowTick.value - props.startedAtMs))
const visible = computed(() => elapsedMs.value >= MIN_VISIBLE_MS)
const elapsedText = computed(() => formatElapsedMs(elapsedMs.value))
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
