<template>
  <div class="round-reply">
    <div v-for="message in messages" :key="message.messageId" class="reply-message">
      <div
        v-if="hasThinking(message)"
        class="reply-thinking"
      >
        <button type="button" class="thinking-header" @click="toggleThinking(message.messageId)">
          <span class="thinking-caret" :class="{ expanded: expandedThinking.has(message.messageId) }">▸</span>
          <span class="thinking-label">思考 {{ message.thinkingContent!.length }} 字</span>
        </button>
        <pre v-if="expandedThinking.has(message.messageId)" class="thinking-body">{{ message.thinkingContent }}</pre>
      </div>
      <div v-if="hasText(message)" class="reply-content">
        <MarkdownContent :content="message.content!" />
      </div>
      <div v-if="!hasThinking(message) && !hasText(message)" class="reply-empty">该条消息无正文内容</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import MarkdownContent from '../common/MarkdownContent.vue'
import type { TraceRoundMessage } from '../../types/trace'

/**
 * 轮次抽屉「回复」tab（技术方案 2026-10-25-run-trace-content-and-prompt §5.6）。
 * 每条助手消息 = 思考折叠块（默认收起，纯文本——聊天侧 ThinkingBlock 同款处理）+
 * markdown 正文（复用聊天同源渲染链路，DOMPurify 消毒在 renderMarkdown 内统一做）。
 * 不渲染工具调用块与图片：工具回到工具抽屉、媒体回到聊天视图，抽屉只做排障文本。
 */

defineProps<{
  messages: TraceRoundMessage[]
}>()

const expandedThinking = ref<Set<number>>(new Set())

function hasThinking(message: TraceRoundMessage): boolean {
  return message.thinkingContent != null && message.thinkingContent !== ''
}

function hasText(message: TraceRoundMessage): boolean {
  return message.content != null && message.content.trim() !== ''
}

function toggleThinking(messageId: number) {
  const next = new Set(expandedThinking.value)
  if (next.has(messageId)) next.delete(messageId)
  else next.add(messageId)
  expandedThinking.value = next
}
</script>

<style scoped>
.round-reply {
  display: flex;
  flex-direction: column;
  gap: var(--aw-space-xxs);
}

.reply-message {
  display: flex;
  flex-direction: column;
  gap: var(--aw-space-xxs);
}

.reply-message + .reply-message {
  border-top: 1px solid var(--aw-divider-soft);
  padding-top: var(--aw-space-xxs);
}

.reply-thinking {
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  overflow: hidden;
}

.thinking-header {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 3px 6px;
  border: none;
  background: var(--aw-surface-pearl);
  cursor: pointer;
  font-family: var(--aw-font-text);
  text-align: left;
}

.thinking-header:hover {
  background: var(--aw-surface-hover);
}

.thinking-caret {
  color: var(--aw-ink-muted-40);
  font-size: 10px;
  transition: transform 0.15s;
}

.thinking-caret.expanded {
  transform: rotate(90deg);
}

.thinking-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-64);
}

.thinking-body {
  margin: 0;
  padding: var(--aw-space-xxs) 6px;
  border-top: 1px solid var(--aw-divider-soft);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  line-height: 1.5;
  color: var(--aw-ink-muted-64);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 320px;
  overflow: auto;
}

.reply-content {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink);
  word-break: break-word;
}

.reply-empty {
  color: var(--aw-ink-muted-40);
  font-size: var(--aw-text-micro);
  padding: 2px 0;
}
</style>
