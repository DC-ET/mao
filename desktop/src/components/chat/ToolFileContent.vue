<template>
  <div class="tool-file-content">
    <template v-if="numbered">
      <div v-for="(line, i) in lines" :key="i" class="file-line">
        <span class="line-no">{{ startLine + i }}</span>
        <span class="line-text">{{ line === '' ? ' ' : line }}</span>
      </div>
    </template>
    <pre v-else class="file-plain"><code>{{ content }}</code></pre>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  content: string
  /** 首行行号：read_file 带 offset 分页读取时从 offset+1 起算 */
  startLine?: number
  numbered?: boolean
}>(), {
  startLine: 1,
  numbered: true,
})

/** 超过此行数放弃行号槽：DOM 行数随文件线性增长，超长文件限高滚动 + 纯文本块已足够阅读 */
const MAX_NUMBERED_LINES = 2000

const lines = computed(() => props.content.split('\n'))
const numbered = computed(() => props.numbered && lines.value.length <= MAX_NUMBERED_LINES)
</script>

<style scoped>
.tool-file-content {
  margin-bottom: 8px;
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow: auto;
  max-height: 320px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 1.5;
}

.file-line {
  display: flex;
  white-space: pre;
}

.line-no {
  flex-shrink: 0;
  width: 44px;
  padding-right: 10px;
  text-align: right;
  color: var(--aw-ink-muted-48);
  user-select: none;
}

.line-text {
  color: var(--aw-text-code);
  padding-right: 12px;
}

.file-plain {
  margin: 0;
  padding: 8px 12px;
}

.file-plain code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
  white-space: pre;
}
</style>
