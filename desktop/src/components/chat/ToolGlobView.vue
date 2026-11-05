<template>
  <!-- glob_search 富视图：查询行 + 文件路径列表。路径按「目录/文件名」分色，
       点击在中心区打开文件（CLOUD/LOCAL 由父组件处理）。 -->
  <div class="tool-glob">
    <div class="query-line">
      <span class="query-pattern">{{ pattern }}</span>
      <span v-if="path || searchRoot" class="query-path">in {{ path || searchRoot }}</span>
    </div>
    <div class="file-list">
      <div
        v-for="file in files"
        :key="file"
        class="file-row"
        :title="file"
        @click="emit('open-file', file)"
      >
        <span class="file-dir">{{ dirOf(file) }}</span>
        <span class="file-name">{{ nameOf(file) }}</span>
      </div>
      <div v-if="!error && files.length === 0" class="empty-hint">未找到匹配的文件</div>
      <div v-if="truncated" class="more-hint">… 已达返回上限，仅显示前 {{ files.length }} 个</div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  pattern: string
  path: string
  searchRoot: string
  files: string[]
  truncated: boolean
  error: string
}>()

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()

function nameOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at >= 0 ? file.slice(at + 1) : file
}

function dirOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at >= 0 ? `${file.slice(0, at + 1)}` : ''
}
</script>

<style scoped>
.tool-glob {
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

/* 查询词不用主色（蓝）：与 shell 命令同口径取墨色，蓝色只留给交互态底纹 */
.query-pattern {
  color: var(--aw-ink);
  word-break: break-all;
}

.query-path {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink-muted-48);
}

.file-list {
  max-height: 280px;
  overflow: auto;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  padding: 6px 0;
}

.file-row {
  display: flex;
  padding: 1px 12px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  white-space: pre;
  cursor: pointer;
}

.file-row:hover {
  background: color-mix(in srgb, var(--aw-primary) 10%, transparent);
}

.file-dir {
  color: var(--aw-ink-muted-48);
}

.file-name {
  color: var(--aw-text-code);
}

.empty-hint,
.more-hint {
  padding: 2px 12px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}
</style>
