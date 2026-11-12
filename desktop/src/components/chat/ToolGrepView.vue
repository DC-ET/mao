<template>
  <!-- grep_search 富视图：查询行 + 按文件分组的命中行。命中行正常色、上下文行
       （contextual）淡显；命中行内匹配片段按 pattern 高亮（grepHighlight）。
       文件头与命中行点击均在中心区打开文件。 -->
  <div class="tool-grep">
    <div class="query-line">
      <span class="query-pattern">{{ pattern }}</span>
      <span v-if="glob" class="query-glob">{{ glob }}</span>
      <span v-if="path" class="query-path">in {{ path }}</span>
    </div>
    <div class="match-list">
      <template v-for="(group, gi) in groups" :key="gi">
        <div class="match-file" :title="group.file" @click="emit('open-file', group.file)">
          {{ group.file }}
        </div>
        <div
          v-for="(row, ri) in group.rows"
          :key="`${gi}-${ri}`"
          class="match-row"
          :class="{ contextual: row.contextual }"
        >
          <span class="match-line-no">{{ row.line }}</span>
          <span class="match-content">
            <template v-for="(seg, si) in highlightPattern(row.content, pattern, ignoreCase)" :key="si">
              <mark v-if="seg.hit" class="hit">{{ seg.text }}</mark>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </div>
      </template>
      <div v-if="!error && groups.length === 0" class="empty-hint">未找到匹配内容</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { highlightPattern } from '../../utils/grepHighlight'

export interface GrepGroup {
  file: string
  rows: { line: number; content: string; contextual: boolean }[]
}

defineProps<{
  pattern: string
  glob: string
  path: string
  ignoreCase: boolean
  groups: GrepGroup[]
  error: string
}>()

const emit = defineEmits<{
  (e: 'open-file', path: string): void
}>()
</script>

<style scoped>
.tool-grep {
  margin-bottom: 8px;
}

.query-line {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  margin-bottom: 4px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

/* 查询词不用主色（蓝）：与 shell 命令同口径取墨色，蓝色只留给交互态底纹 */
.query-pattern {
  color: var(--aw-ink);
  word-break: break-all;
}

.query-glob {
  flex-shrink: 0;
  padding: 0 4px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-xs);
}

.query-path {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink-muted-48);
}

.match-list {
  max-height: 280px;
  overflow: auto;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-code);
  padding: 6px 0;
}

.match-file {
  padding: 2px 12px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink);
  white-space: pre;
  cursor: pointer;
}

.match-file:hover {
  background: color-mix(in srgb, var(--aw-primary) 10%, transparent);
}

.match-row {
  display: flex;
  padding: 0 12px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  line-height: 1.5;
  color: var(--aw-text-code);
  white-space: pre-wrap;
  word-break: break-all;
}

.match-row.contextual {
  color: var(--aw-ink-muted-48);
}

.match-line-no {
  flex-shrink: 0;
  width: 3.5em;
  margin-right: 10px;
  text-align: right;
  color: var(--aw-ink-muted-48);
  user-select: none;
}

.match-content {
  min-width: 0;
}

.hit {
  background: color-mix(in srgb, var(--aw-warning, #b45309) 30%, transparent);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}

.empty-hint {
  padding: 2px 12px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}
</style>
