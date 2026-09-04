<script setup lang="ts">
import { computed, ref } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ChatMessage } from '../types';

const props = defineProps<{ message: ChatMessage }>();

marked.setOptions({ async: false, gfm: true, breaks: true });

const md = computed(() => {
  if (props.message.role !== 'assistant') return '';
  const raw = marked.parse(props.message.content) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
});

const thinkingOpen = ref(false);
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
