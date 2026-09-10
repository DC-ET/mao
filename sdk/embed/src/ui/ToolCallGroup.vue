<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolCallItem } from '../types';

const props = defineProps<{ toolCalls: ToolCallItem[] }>();
const expanded = ref(false);
const running = computed(() => props.toolCalls.filter((tc) => tc.status === 'running').length);
const failed = computed(() => props.toolCalls.filter((tc) => tc.status === 'error').length);
const unknown = computed(() => props.toolCalls.filter((tc) => tc.status === 'unknown').length);
const images = computed(() => props.toolCalls.filter((tc) => tc.imagePreview));
const summary = computed(() => [
  `${props.toolCalls.length} 个工具调用`,
  running.value ? `${running.value} 个执行中` : unknown.value ? '' : '执行结束',
  unknown.value ? `${unknown.value} 个结果未记录` : '',
  failed.value ? `${failed.value} 个失败` : '',
].filter(Boolean).join(' · '));
</script>

<template>
  <div class="mao-toolgroup">
    <button
      type="button"
      class="mao-thinking__summary mao-toolgroup__summary"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="mao-thinking__caret" :class="{ 'mao-thinking__caret--open': expanded }" aria-hidden="true" />
      <span>{{ summary }}</span>
    </button>
    <img
      v-for="tc in images"
      :key="tc.toolCallId"
      class="mao-toolcard__image"
      :src="tc.imagePreview"
      alt=""
    />
    <div v-if="expanded" class="mao-toolgroup__body">
      <div v-for="tc in toolCalls" :key="tc.toolCallId" class="mao-toolcard">
        <div class="mao-toolcard__head">
          <span class="mao-toolcard__name">{{ tc.displayName || tc.toolName }}</span>
          <span class="mao-toolcard__status" :class="`mao-toolcard__status--${tc.status}`">
            {{ tc.status === 'running' ? '执行中' : tc.status === 'done' ? '完成' : tc.status === 'error' ? '失败' : '结果未记录' }}
          </span>
        </div>
        <div v-if="tc.argsText" class="mao-toolcard__args">{{ tc.argsText }}</div>
        <div v-if="tc.resultText" class="mao-toolcard__result">{{ tc.resultText }}</div>
      </div>
    </div>
  </div>
</template>
