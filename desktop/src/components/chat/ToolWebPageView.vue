<template>
  <!-- open_web_page 富视图：标题 + url（外链）+ Markdown 正文。正文复用消息同款
       MarkdownContent（content 即 turndown 产物），基础排版规则随本组件 scoped 携带
       （.markdown-body 的全局规则只有 mermaid/katex/表格增强，基础排版此前只在
       MessageBubble 的 scoped 作用域内生效）。 -->
  <div class="tool-web-page">
    <div class="page-head">
      <div class="page-title" :title="title || url">{{ title || url }}</div>
      <a class="page-url" :href="url" target="_blank" rel="noopener noreferrer">{{ url }}</a>
    </div>
    <MarkdownContent
      v-if="content"
      class="page-body"
      :content="content"
      body-class="markdown-body tool-page-body"
    />
    <div v-else-if="!error" class="empty-hint">未提取到正文内容</div>
    <div v-if="truncated" class="page-truncated">
      <span>正文已截断</span>
      <button v-if="fullFile" class="link-btn" :title="fullFile" @click="emit('open-file', fullFile)">
        完整内容：{{ fullFile }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import MarkdownContent from '../common/MarkdownContent.vue'

defineProps<{
  url: string
  title: string
  content: string
  truncated: boolean
  fullFile: string
  error: string
}>()

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()
</script>

<style scoped>
.tool-web-page {
  margin-bottom: 8px;
}

.page-head {
  margin-bottom: 6px;
}

.page-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* url 不用主色（蓝）：中性灰 + 悬停下划线表明可点，蓝色只留给 markdown 内的链接 */
.page-url {
  display: block;
  margin-top: 1px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-url:hover {
  text-decoration: underline;
}

.page-body {
  max-height: 320px;
  overflow: auto;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  padding: 8px 12px;
}

.page-truncated {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 4px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-btn:hover {
  text-decoration: underline;
}

.empty-hint {
  padding: 4px 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

/* ---- MarkdownContent 基础排版（与 MessageBubble.markdown-body 同口径，scoped 随本组件生效） ---- */
.tool-page-body :deep(p) {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 1.8;
}

.tool-page-body :deep(pre) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.tool-page-body :deep(.code-block) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.tool-page-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--aw-surface-code-header);
  font-size: var(--aw-text-fine);
}

.tool-page-body :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
}

.tool-page-body :deep(.code-copy-btn) {
  height: var(--aw-btn-height);
  background: none;
  border: 1px solid var(--aw-hairline);
  color: var(--aw-ink-muted-48);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  font-size: var(--aw-text-fine);
}

.tool-page-body :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.tool-page-body :deep(code) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
}

.tool-page-body :deep(.monaco-code) {
  display: block;
  padding: 12px;
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 20px;
}

.tool-page-body :deep(ul),
.tool-page-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.tool-page-body :deep(li) {
  font-size: var(--aw-text-caption);
  line-height: 1.8;
}

.tool-page-body :deep(blockquote) {
  margin: 2px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.tool-page-body :deep(table) {
  border-collapse: collapse;
  margin: 2px 0;
  width: 100%;
}

.tool-page-body :deep(th),
.tool-page-body :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 6px 10px;
  text-align: left;
  font-size: var(--aw-text-caption);
}

.tool-page-body :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}

.tool-page-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 2px 0;
}

.tool-page-body :deep(h1),
.tool-page-body :deep(h2),
.tool-page-body :deep(h3),
.tool-page-body :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 4px 0 2px;
}

.tool-page-body :deep(h1) { font-size: var(--aw-text-lead); }
.tool-page-body :deep(h2) { font-size: var(--aw-text-tagline); }
.tool-page-body :deep(h3) { font-size: var(--aw-text-body); }
.tool-page-body :deep(h4) { font-size: var(--aw-text-caption); }
</style>
