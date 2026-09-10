<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../types';
import { renderMarkdown } from './markdown';
import { parseUserContent } from './userContent';
import ToolCallGroup from './ToolCallGroup.vue';

const props = defineProps<{ message: ChatMessage }>();
const segments = computed(() => props.message.segments.map((segment) => (
  segment.type === 'text' ? { ...segment, html: renderMarkdown(segment.content) } : segment
)));
/** 用户消息：图片附件 + 文件引用 chip + 纯文本正文 */
const userContent = computed(() => (
  props.message.role === 'user' ? parseUserContent(props.message.content) : { text: '', files: [] }
));
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
        <div v-if="message.images && message.images.length > 0" class="mao-msg__images">
          <img v-for="(url, index) in message.images" :key="index" class="mao-msg__image" :src="url" alt="附件图片" />
        </div>
        <div v-if="userContent.files.length > 0" class="mao-msg__files">
          <span v-for="file in userContent.files" :key="file.path" class="mao-msg__file" :title="file.path">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm-1 7V3.5L18.5 9Z"/></svg>
            {{ file.name }}
          </span>
        </div>
        <span v-if="userContent.text" class="mao-msg__text">{{ userContent.text }}</span>
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
