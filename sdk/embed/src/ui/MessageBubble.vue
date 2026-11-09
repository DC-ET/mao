<script setup lang="ts">
import { computed } from 'vue';
import type { ChatMessage } from '../types';
import { parseUserContent } from './userContent';

/**
 * 用户气泡：引用块 + 图片附件 + 文件引用 chip + 纯文本正文。
 * 助手的执行过程与回复由 ChatPanel 的轮次视图（useRounds）渲染，不再走气泡。
 */
const props = defineProps<{ message: ChatMessage }>();

/** 用户消息：图片附件 + 文件引用 chip + 纯文本正文 */
const userContent = computed(() => parseUserContent(props.message.content));
</script>

<template>
  <div class="mao-msg mao-msg--user">
    <div class="mao-msg__bubble">
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
    </div>
  </div>
</template>
