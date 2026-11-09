<script setup lang="ts">
import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue';
import MaoIcon from './MaoIcon.vue';
import { ICON_THINKING, ICON_ARROW_DOWN } from './icons';

const props = defineProps<{
  thinking: string;
  /** 这段思考仍在流出：行头转圈、标签「思考中…」、头部空白区滚动预览最新片段 */
  streaming?: boolean;
}>();

const isExpanded = ref(false);
const bodyRef = ref<HTMLElement | null>(null);
const previewRef = ref<HTMLElement | null>(null);

// 思考中未展开时，头部空白区滚动展示最新思考片段：
// 文本始终取末尾片段，scrollLeft 缓动跟随尾部，形成连续滑动效果（对齐桌面端 ThinkingBlock）。
const PREVIEW_MAX_CHARS = 2000;
const previewText = computed(() => {
  const t = props.thinking || '';
  return t.length > PREVIEW_MAX_CHARS ? t.slice(-PREVIEW_MAX_CHARS) : t;
});

let previewRaf = 0;

function stopPreviewEase() {
  if (previewRaf) {
    cancelAnimationFrame(previewRaf);
    previewRaf = 0;
  }
}

function startPreviewEase() {
  if (previewRaf || typeof requestAnimationFrame !== 'function') return;
  const step = () => {
    const el = previewRef.value;
    if (el) {
      const target = el.scrollWidth - el.clientWidth;
      if (target > 0) {
        const diff = target - el.scrollLeft;
        el.scrollLeft = Math.abs(diff) < 1 ? target : el.scrollLeft + diff * 0.1;
      }
    }
    previewRaf = requestAnimationFrame(step);
  };
  previewRaf = requestAnimationFrame(step);
}

watch([() => props.streaming, isExpanded], ([streaming, expanded]) => {
  if (streaming && !expanded) startPreviewEase();
  else stopPreviewEase();
}, { immediate: true });

onBeforeUnmount(stopPreviewEase);

function toggleExpand() {
  isExpanded.value = !isExpanded.value;
}

// 展开态流式中自动跟滚到底
watch(() => props.thinking, async () => {
  if (props.streaming && isExpanded.value && bodyRef.value) {
    await nextTick();
    bodyRef.value.scrollTop = bodyRef.value.scrollHeight;
  }
});
</script>

<template>
  <div class="mao-think">
    <button
      type="button"
      class="mao-think__header"
      :aria-expanded="isExpanded"
      @click="toggleExpand"
    >
      <span class="mao-think__info">
        <span v-if="streaming" class="mao-spinner" aria-hidden="true" />
        <MaoIcon v-else :icon="ICON_THINKING" :size="14" class="mao-think__icon" />
        <span class="mao-think__label">{{ streaming ? '思考中…' : '思考完成' }}</span>
        <span v-if="streaming && !isExpanded && thinking" ref="previewRef" class="mao-think__preview">
          <span class="mao-think__preview-text">{{ previewText }}</span>
        </span>
      </span>
      <MaoIcon
        :icon="ICON_ARROW_DOWN"
        :size="12"
        class="mao-chevron"
        :class="{ 'mao-chevron--open': isExpanded }"
      />
    </button>
    <div v-if="isExpanded" ref="bodyRef" class="mao-think__body">
      <pre class="mao-think__content">{{ thinking }}</pre>
    </div>
  </div>
</template>
