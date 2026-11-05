<template>
  <!-- web_search 富视图：查询行 + 结果列表。每条 = 标题（外链）+ host + 摘要（两行截断）。
       外链用 target=_blank：Electron setWindowOpenHandler 转 shell.openExternal，Web 开新标签。 -->
  <div class="tool-web-search">
    <div class="query-line">
      <span class="query-pattern">{{ query }}</span>
    </div>
    <div class="result-list">
      <a
        v-for="(item, i) in items"
        :key="i"
        class="result-row"
        :href="item.url"
        target="_blank"
        rel="noopener noreferrer"
      >
        <div class="result-title" :title="item.title">{{ item.title || item.url }}</div>
        <div class="result-host">{{ hostOf(item.url) }}</div>
        <div v-if="item.content" class="result-snippet">{{ item.content }}</div>
      </a>
      <div v-if="!error && items.length === 0" class="empty-hint">未找到相关结果</div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface WebSearchItem {
  title: string
  url: string
  content: string
}

defineProps<{
  query: string
  items: WebSearchItem[]
  error: string
}>()

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
</script>

<style scoped>
.tool-web-search {
  margin-bottom: 8px;
}

.query-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin-bottom: 4px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
}

.query-pattern {
  color: var(--aw-primary);
  word-break: break-all;
}

.result-list {
  max-height: 280px;
  overflow: auto;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  padding: 4px 0;
}

.result-row {
  display: block;
  padding: 6px 12px;
  text-decoration: none;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.result-row:last-child {
  border-bottom: none;
}

.result-row:hover {
  background: color-mix(in srgb, var(--aw-primary) 8%, transparent);
}

.result-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result-host {
  margin-top: 1px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.result-snippet {
  margin-top: 2px;
  font-size: var(--aw-text-fine);
  line-height: 1.5;
  color: var(--aw-text-code);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.empty-hint {
  padding: 4px 12px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}
</style>
