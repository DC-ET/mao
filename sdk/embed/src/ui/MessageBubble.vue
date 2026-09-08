<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../types';
import { renderMarkdown } from './markdown';
import ToolCallGroup from './ToolCallGroup.vue';

const props = defineProps<{ message: ChatMessage }>();
const segments = computed(() => props.message.segments.map((segment) => (
  segment.type === 'text' ? { ...segment, html: renderMarkdown(segment.content) } : segment
)));
/** 对齐桌面端：流式正文后、或等待下一段输出时显示三点；工具正在跑时不叠一层 loading */
const showTypingDots = computed(() => {
  if (props.message.role !== 'assistant' || !props.message.streaming) return false;
  const last = props.message.segments[props.message.segments.length - 1];
  if (last?.type === 'text') return true;
  return !props.message.toolCalls.some((tc) => tc.status === 'running');
});
</script>

<template>
  <div class="mao-msg" :class="message.role === 'user' ? 'mao-msg--user' : 'mao-msg--assistant'">
    <div class="mao-msg__bubble" :class="{ 'mao-msg__bubble--error': message.error }">
      <template v-if="message.role === 'user'">
        <div v-if="message.quotedSelection" class="mao-msg__quote">
          <span class="mao-msg__quote-label">讨论</span>
          <span class="mao-msg__quote-text">{{ message.quotedSelection }}</span>
        </div>
        <span class="mao-msg__text">{{ message.content }}</span>
      </template>
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
            v-html="'html' in segment ? segment.html : ''"
          />
        </template>
        <div v-if="showTypingDots" class="mao-typing" aria-hidden="true">
          <span /><span /><span />
        </div>
      </template>
    </div>
  </div>
</template>
