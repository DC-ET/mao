<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import { renderMarkdown } from './markdown';

const props = defineProps<{ message: ChatMessage }>();

const md = computed(() => {
  if (props.message.role !== 'assistant') return '';
  return renderMarkdown(props.message.content);
});

// 思考流式期间默认展开（长思考时界面否则像卡住），本轮结束后自动折叠
const thinkingOpen = ref(props.message.streaming && !props.message.content);
watch(
  () => props.message.streaming,
  (streaming, prev) => {
    if (streaming && !prev) thinkingOpen.value = !props.message.content;
    else if (!streaming && prev) thinkingOpen.value = false;
  },
);
</script>

<template>
  <div class="mao-msg" :class="message.role === 'user' ? 'mao-msg--user' : 'mao-msg--assistant'">
    <div class="mao-msg__bubble" :class="{ 'mao-msg__bubble--error': message.error }">
      <template v-if="message.role === 'user'">{{ message.content }}</template>
      <template v-else>
        <div v-if="message.thinking" class="mao-thinking">
          <div class="mao-thinking__summary" @click="thinkingOpen = !thinkingOpen">
            {{ thinkingOpen ? '收起思考' : '思考过程' }}
          </div>
          <div v-if="thinkingOpen" class="mao-thinking__body">{{ message.thinking }}</div>
        </div>
        <div v-for="tc in message.toolCalls" :key="tc.toolCallId" class="mao-toolcard">
          <div class="mao-toolcard__head">
            <span>{{ tc.displayName || tc.toolName }}</span>
            <span
              class="mao-toolcard__status"
              :class="`mao-toolcard__status--${tc.status}`"
            >{{ tc.status === 'running' ? '执行中' : tc.status === 'done' ? '完成' : '失败' }}</span>
          </div>
          <div v-if="tc.argsText" class="mao-toolcard__args">{{ tc.argsText }}</div>
          <div v-if="tc.resultText" class="mao-toolcard__result">{{ tc.resultText }}</div>
        </div>
        <div
          v-if="message.content"
          class="mao-msg__md"
          :class="{ 'mao-cursor': message.streaming }"
          v-html="md"
        />
        <div
          v-else-if="message.streaming && message.toolCalls.length === 0"
          class="mao-cursor"
        />
      </template>
    </div>
  </div>
</template>
