<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ToolCallItem } from '../types';

const props = defineProps<{ toolCalls: ToolCallItem[] }>();
const expanded = ref(false);
const lightboxSrc = ref<string | null>(null);
const teleportTo = ref<HTMLElement | null>(null);
const rootEl = ref<HTMLElement | null>(null);
const running = computed(() => props.toolCalls.filter((tc) => tc.status === 'running').length);
const failed = computed(() => props.toolCalls.filter((tc) => tc.status === 'error').length);
const unknown = computed(() => props.toolCalls.filter((tc) => tc.status === 'unknown').length);
const summary = computed(() => [
  `${props.toolCalls.length} 个工具调用`,
  running.value ? `${running.value} 个执行中` : unknown.value ? '' : '执行结束',
  unknown.value ? `${unknown.value} 个结果未记录` : '',
  failed.value ? `${failed.value} 个失败` : '',
].filter(Boolean).join(' · '));

onMounted(() => {
  const rootNode = rootEl.value?.getRootNode();
  const root = rootNode instanceof ShadowRoot || rootNode instanceof Document
    ? rootNode.querySelector('.mao-root')
    : null;
  teleportTo.value = root instanceof HTMLElement ? root : null;
  document.addEventListener('keydown', onKeydown, true);
});
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true));

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !lightboxSrc.value) return;
  e.preventDefault();
  e.stopPropagation();
  lightboxSrc.value = null;
}

function openLightbox(src: string) {
  lightboxSrc.value = src;
}

function closeLightbox() {
  lightboxSrc.value = null;
}
</script>

<template>
  <div ref="rootEl" class="mao-toolgroup">
    <button
      type="button"
      class="mao-thinking__summary mao-toolgroup__summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="mao-thinking__caret" :class="{ 'mao-thinking__caret--open': expanded }" aria-hidden="true" />
      <span>{{ summary }}</span>
    </button>
    <div v-if="expanded" class="mao-toolgroup__body">
      <div v-for="tc in toolCalls" :key="tc.toolCallId" class="mao-toolcard">
        <div class="mao-toolcard__head">
          <span class="mao-toolcard__name">{{ tc.displayName || tc.toolName }}</span>
          <span class="mao-toolcard__status" :class="`mao-toolcard__status--${tc.status}`">
            {{ tc.status === 'running' ? '执行中' : tc.status === 'done' ? '完成' : tc.status === 'error' ? '失败' : '结果未记录' }}
          </span>
        </div>
        <div v-if="tc.argsText" class="mao-toolcard__args">{{ tc.argsText }}</div>
        <button
          v-if="tc.imagePreview"
          type="button"
          class="mao-toolcard__thumb"
          title="查看大图"
          @click="openLightbox(tc.imagePreview)"
        >
          <img class="mao-toolcard__image" :src="tc.imagePreview" alt="页面截图" />
        </button>
        <div v-if="tc.resultText" class="mao-toolcard__result">{{ tc.resultText }}</div>
      </div>
    </div>
    <Teleport :to="teleportTo ?? 'body'" :disabled="!teleportTo">
      <div
        v-if="lightboxSrc"
        class="mao-lightbox"
        role="dialog"
        aria-modal="true"
        aria-label="查看大图"
        @click="closeLightbox"
      >
        <img class="mao-lightbox__img" :src="lightboxSrc" alt="" @click.stop />
        <button type="button" class="mao-lightbox__close" title="关闭" aria-label="关闭" @click="closeLightbox">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
      </div>
    </Teleport>
  </div>
</template>
