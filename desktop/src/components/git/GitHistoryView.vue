<template>
  <div class="git-history-view">
    <div v-if="error && entries.length === 0" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('retry')">重试</button>
    </div>
    <div v-else-if="loading && entries.length === 0" class="git-state">加载中…</div>
    <div v-else-if="entries.length === 0" class="git-state">尚无提交</div>
    <div v-else class="git-log-list">
      <div
        v-for="entry in entries"
        :key="entry.hash"
        class="git-log-row"
        :class="{ expanded: expandedCommit === entry.hash }"
      >
        <div class="git-log-main" @click="$emit('toggle-commit', entry.hash)">
          <el-icon :size="12" class="git-log-expand-icon">
            <ArrowRight v-if="expandedCommit !== entry.hash" />
            <ArrowDown v-else />
          </el-icon>
          <span
            class="git-log-hash"
            title="点击复制完整提交哈希"
            @click.stop="copyHash(entry.hash)"
          >{{ entry.shortHash }}</span>
          <span class="git-log-title" :title="entry.title">{{ entry.title || '（无标题）' }}</span>
          <span class="git-log-meta">
            <span v-for="ref in decorations(entry)" :key="`${ref.kind}:${ref.name}`" class="git-log-ref" :class="`is-${ref.kind}`">
              {{ ref.name }}
            </span>
            <span class="git-log-author">{{ entry.author }}</span>
            <span class="git-log-date" :title="entry.date">{{ formatRelativeTime(entry.date) }}</span>
          </span>
        </div>
        <div v-if="expandedCommit === entry.hash" class="git-commit-files">
          <div v-if="commitFilesLoading && !commitFiles?.get(entry.hash)" class="git-commit-files-state">读取文件清单…</div>
          <template v-else-if="commitFiles?.get(entry.hash)">
            <div
              v-for="file in commitFiles.get(entry.hash)"
              :key="file.path"
              class="git-commit-file"
              @click="$emit('open-commit-diff', { hash: entry.hash, file })"
            >
              <span class="git-commit-file-badge" :class="badgeClass(file.changeType)">{{ changeTypeLabel(file.changeType) }}</span>
              <span class="git-commit-file-path" :title="file.path">{{ file.path }}</span>
              <span class="git-commit-file-stat">
                <span v-if="file.insertions" class="git-add">+{{ file.insertions }}</span>
                <span v-if="file.deletions" class="git-del">-{{ file.deletions }}</span>
              </span>
            </div>
          </template>
          <div v-else class="git-commit-files-state">该提交没有文件变更</div>
        </div>
      </div>
      <div class="git-log-footer">
        <button v-if="!exhausted" class="git-log-more" :disabled="loading" @click="$emit('load-more')">
          {{ loading ? '加载中…' : '加载更多' }}
        </button>
        <span v-else class="git-log-end">已显示全部提交</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown, ArrowRight } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { GitChangedFile, GitLogEntry, GitRemoteInfo } from '../../types/git'
import { formatRelativeTime, parseRefsDecorations, type RefDecoration } from '../../utils/git-manager'
import { copyText } from '../../utils/clipboard'

const props = defineProps<{
  entries: GitLogEntry[]
  loading?: boolean
  error?: string
  exhausted?: boolean
  expandedCommit?: string | null
  commitFiles?: Map<string, GitChangedFile[]>
  commitFilesLoading?: boolean
  remotes?: GitRemoteInfo[]
}>()

const emit = defineEmits<{
  'load-more': []
  retry: []
  'toggle-commit': [hash: string]
  'open-commit-diff': [payload: { hash: string; file: GitChangedFile }]
}>()

const remoteNames = computed(() => (props.remotes ?? []).map((r) => r.name))

function decorations(entry: GitLogEntry): RefDecoration[] {
  return parseRefsDecorations(entry.refs, remoteNames.value)
}

async function copyHash(hash: string) {
  const ok = await copyText(hash)
  if (ok) ElMessage.success('完整哈希已复制')
  else ElMessage.error('复制失败，请手动记录')
}

function changeTypeLabel(type: string): string {
  switch (type) {
    case 'CREATED': return '新增'
    case 'DELETED': return '删除'
    case 'RENAMED': return '改名'
    case 'COPIED': return '复制'
    default: return '修改'
  }
}

function badgeClass(type: string): string {
  switch (type) {
    case 'CREATED': return 'is-added'
    case 'DELETED': return 'is-deleted'
    case 'RENAMED':
    case 'COPIED': return 'is-renamed'
    default: return 'is-modified'
  }
}
</script>

<style scoped>
.git-history-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.git-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.git-error p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

.git-log-list {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.git-log-row {
  border-bottom: 1px solid var(--aw-divider-soft);
}

.git-log-row.expanded {
  background: var(--aw-surface-hover);
}

.git-log-main {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

.git-log-main:hover {
  background: var(--aw-canvas-parchment);
}

.git-log-expand-icon {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.git-log-hash {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  cursor: copy;
}

.git-log-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink);
}

.git-log-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 50%;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.git-log-author {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-log-date {
  font-variant-numeric: tabular-nums;
}

.git-log-ref {
  padding: 0 5px;
  border-radius: 7px;
  font-size: var(--aw-text-fine);
  line-height: 16px;
  white-space: nowrap;
  background: rgba(0, 0, 0, 0.05);
  color: var(--aw-ink-muted-64);
}

.git-log-ref.is-head {
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
}

.git-log-ref.is-remote {
  background: rgba(0, 0, 0, 0.04);
  color: var(--aw-ink-muted-48);
}

.git-log-ref.is-tag {
  background: rgba(255, 159, 10, 0.12);
  color: var(--aw-warning);
}

.git-commit-files {
  padding: 2px 12px 8px 30px;
  background: var(--aw-canvas-parchment);
}

.git-commit-files-state {
  padding: 6px 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.git-commit-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.git-commit-file:hover {
  background: var(--aw-surface-hover);
}

.git-commit-file-badge {
  flex-shrink: 0;
  width: 26px;
  text-align: center;
  border-radius: 4px;
  font-size: 10px;
  line-height: 15px;
  background: rgba(0, 0, 0, 0.05);
  color: var(--aw-ink-muted-48);
}

.git-commit-file-badge.is-added { color: var(--aw-diff-add); }
.git-commit-file-badge.is-deleted { color: var(--aw-diff-del); }
.git-commit-file-badge.is-renamed { color: var(--aw-primary); }
.git-commit-file-badge.is-modified { color: var(--aw-ink-muted-64); }

.git-commit-file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

.git-commit-file-stat {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-family: var(--aw-font-mono);
}

.git-add { color: var(--aw-diff-add); }
.git-del { color: var(--aw-diff-del); }

.git-log-footer {
  padding: 12px;
  text-align: center;
}

.git-log-more {
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-caption);
  padding: 5px 16px;
  cursor: pointer;
}

.git-log-more:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.git-log-more:disabled {
  opacity: 0.5;
  cursor: default;
}

.git-log-end {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

[data-theme="dark"] .git-log-row {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-log-main:hover {
  background: rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .git-log-ref,
[data-theme="dark"] .git-commit-file-badge {
  background: rgba(255, 255, 255, 0.08);
}

[data-theme="dark"] .git-log-ref.is-remote {
  background: rgba(255, 255, 255, 0.06);
}
</style>
