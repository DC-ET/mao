<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../types';
import { renderMarkdown } from './markdown';
import ToolCallGroup from './ToolCallGroup.vue';

const props = defineProps<{ message: ChatMessage }>();
const segments = computed(() => props.message.segments.map((segment) => (
  segment.type === 'text' ? { ...segment, html: renderMarkdown(segment.content) } : segment
)));
</script>

<template>
  <div class="mao-msg" :class="message.role === 'user' ? 'mao-msg--user' : 'mao-msg--assistant'">
    <div class="mao-msg__bubble" :class="{ 'mao-msg__bubble--error': message.error }">
      <template v-if="message.role === 'user'">{{ message.content }}</template>
      <template v-else>
        <template v-for="(segment, index) in segments" :key="index">
          <details v-if="segment.type === 'thinking'" class="mao-thinking">
            <summary class="mao-thinking__summary">
              <span class="mao-thinking__caret" aria-hidden="true" />
              思考过程
            </summary>
            <div class="mao-thinking__body">{{ segment.content }}</div>
          </details>
          <ToolCallGroup v-else-if="segment.type === 'tool-group'" :tool-calls="segment.toolCalls" />
          <div
            v-else
            class="mao-msg__md"
            :class="{ 'mao-cursor': message.streaming && index === segments.length - 1 }"
            v-html="'html' in segment ? segment.html : ''"
          />
        </template>
        <div v-if="message.streaming && segments[segments.length - 1]?.type !== 'text'" class="mao-cursor" />
      </template>
    </div>
  </div>
</template>
