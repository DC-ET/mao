<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { formatElapsedMs } from './elapsed';

const props = defineProps<{
  /** 起表时刻（epoch ms）；缺省时不渲染（调用方 v-if 守门，这里双保险） */
  startedAtMs?: number;
}>();

/** 展示阈值：耗时满 1s 才显示——绝大多数工具调用远小于 1s，一闪而过的数字只是噪音 */
const MIN_VISIBLE_MS = 1000;

// 秒级走表：执行中「卡了多久」只能靠客户端时钟回答。定时器被节流后恢复时
// Date.now() 差值自动追平，不会越走越慢（对齐 desktop ToolCallElapsed）。
const nowTick = ref(Date.now());
const timer = props.startedAtMs == null
  ? null
  : window.setInterval(() => { nowTick.value = Date.now(); }, 1000);
onUnmounted(() => {
  if (timer != null) window.clearInterval(timer);
});

const elapsedMs = computed(() =>
  props.startedAtMs == null ? 0 : Math.max(0, nowTick.value - props.startedAtMs));
const visible = computed(() => elapsedMs.value >= MIN_VISIBLE_MS);
const elapsedText = computed(() => formatElapsedMs(elapsedMs.value));
</script>

<template>
  <span v-if="visible" class="mao-elapsed">{{ elapsedText }}</span>
</template>
