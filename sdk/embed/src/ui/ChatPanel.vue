<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ChatMessage, PendingQuestion } from '../types';
import MessageBubble from './MessageBubble.vue';
import Composer from './Composer.vue';
import QuestionCard from './QuestionCard.vue';

const props = defineProps<{
  open: boolean;
  position: 'right' | 'left';
  connected: boolean;
  phase: string | null;
  sessionTitle: string;
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  pendingQuestion: PendingQuestion | null;
  quotedSelection: string | null;
}>();

const emit = defineEmits<{
  close: [];
  newSession: [];
  send: [content: string];
  stop: [];
  answer: [requestId: string, answers: unknown[]];
  clearSelection: [];
  retry: [];
}>();

const listEl = ref<HTMLElement | null>(null);

const running = computed(
  () =>
    props.phase === 'RUNNING' ||
    props.phase === 'RESUMING' ||
    props.phase === 'WAITING_APPROVAL',
);
const inputDisabled = computed(() => !props.connected || running.value);

watch(
  () => props.messages.map((m) => (m.role === 'assistant' ? m.content.length + m.thinking.length + m.toolCalls.length : 1)),
  () => {
    void nextTick(() => {
      const el = listEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

function onEmptySlot(): boolean {
  return props.messages.length === 0;
}
</script>

<template>
  <div v-if="open" class="mao-panel" :data-pos="position" role="dialog" aria-label="Mao 助手对话">
    <div class="mao-panel__header">
      <span class="mao-panel__conn" :class="{ 'mao-panel__conn--on': connected }" />
      <span class="mao-panel__title">{{ sessionTitle }}</span>
      <button class="mao-panel__btn" type="button" title="新对话" :disabled="running" @click="emit('newSession')">
        <svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4Z"/></svg>
      </button>
      <button class="mao-panel__btn" type="button" title="关闭" @click="emit('close')">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>

    <div ref="listEl" class="mao-messages">
      <MessageBubble v-for="m in messages" :key="m.id" :message="m" />
      <div v-if="onEmptySlot()" class="mao-empty">向 Agent 提问，它会结合当前页面内容回答</div>
    </div>

    <div v-if="llmRetryText" class="mao-banner mao-banner--info">{{ llmRetryText }}</div>
    <div v-if="sessionError" class="mao-banner mao-banner--error">
      <span>{{ sessionError }}</span>
      <button v-if="!running" class="mao-banner__retry" type="button" @click="emit('retry')">重试</button>
    </div>

    <QuestionCard
      v-if="pendingQuestion"
      :pending="pendingQuestion"
      @submit="(id, answers) => emit('answer', id, answers)"
    />

    <Composer
      :disabled="inputDisabled"
      :running="running"
      :quoted-selection="quotedSelection"
      :connection-error="!connected"
      @send="(c) => emit('send', c)"
      @stop="emit('stop')"
      @clear-selection="emit('clearSelection')"
    />
  </div>
</template>
