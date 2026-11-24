<template>
  <div class="git-history-view">
    <!-- 筛选条：路径过滤（后端既有参数）+ 提交信息搜索（keyword）；空仓库且无筛选时不渲染 -->
    <div v-if="entries.length > 0 || pathFilter || keyword || allBranches" class="git-history-filters">
      <input
        class="git-filter-input"
        :value="pathFilter"
        maxlength="200"
        placeholder="按文件路径筛选（如 src/app.ts）"
        @input="$emit('update:pathFilter', ($event.target as HTMLInputElement).value)"
      />
      <input
        class="git-filter-input"
        :value="keyword"
        maxlength="100"
        placeholder="按提交信息搜索"
        @input="$emit('update:keyword', ($event.target as HTMLInputElement).value)"
      />
      <label class="git-filter-toggle" title="显示全部本地 / 远端分支与标签的提交；关闭时只看当前分支">
        <input
          type="checkbox"
          :checked="allBranches"
          @change="$emit('update:allBranches', ($event.target as HTMLInputElement).checked)"
        />
        <span>全部分支</span>
      </label>
    </div>
    <!-- 按路径 / 关键词过滤后相邻两行不一定是父子关系，画出的线是假的 -->
    <div v-if="entries.length > 0 && !graphEnabled" class="git-graph-hint">筛选中不显示图谱</div>
    <div v-if="error && entries.length === 0" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('retry')">重试</button>
    </div>
    <div v-else-if="loading && entries.length === 0" class="git-state">加载中…</div>
    <div v-else-if="entries.length === 0" class="git-state">尚无提交</div>
    <div v-else class="git-log-list" :class="{ 'has-graph': graph }">
      <div
        v-for="(entry, index) in entries"
        :key="entry.hash"
        class="git-log-row"
        :class="{ expanded: expandedCommit === entry.hash }"
      >
        <div class="git-log-main" @click="$emit('toggle-commit', entry.hash)">
          <GitGraphCell
            v-if="graph"
            :lanes="graphLanes"
            :row="graph.rows[index]"
            :dangling-bottom="exhausted && index === entries.length - 1"
          />
          <el-icon :size="12" class="git-log-expand-icon">
            <ArrowRight v-if="expandedCommit !== entry.hash" />
            <ArrowDown v-else />
          </el-icon>
          <span
            class="git-log-hash"
            title="点击复制完整提交哈希"
            @click.stop="copyHash(entry.hash)"
          >{{ entry.shortHash }}</span>
          <span v-if="entry.parents.length > 1" class="git-log-title is-merge" :title="entry.title">
            <el-icon :size="12" class="git-log-merge-icon"><Share /></el-icon>{{ mergeTitle(entry) }}
          </span>
          <span v-else class="git-log-title" :title="entry.title">{{ entry.title || '（无标题）' }}</span>
          <span class="git-log-meta">
            <span v-for="ref in decorations(entry)" :key="`${ref.kind}:${ref.name}`" class="git-log-ref" :class="`is-${ref.kind}`">
              {{ ref.name }}
            </span>
            <span class="git-log-author">{{ entry.author }}</span>
            <span class="git-log-date" :title="entry.date">{{ formatRelativeTime(entry.date) }}</span>
          </span>
          <span class="git-log-quote" title="添加到对话" @click.stop="$emit('add-commit-to-chat', `提交 ${entry.shortHash}（${entry.title || '无标题'}）`)">
            <el-icon :size="12"><ChatDotRound /></el-icon>
          </span>
        </div>
        <div v-if="expandedCommit === entry.hash" class="git-commit-expand">
          <GitGraphCell v-if="graph" :lanes="graphLanes" :pass-lanes="graph.rows[index].passLanes" />
          <div class="git-commit-files">
            <!-- 提交正文（%B 去首行标题）：展开时才随文件清单带回，无正文不渲染 -->
            <pre v-if="commitBodies?.get(entry.hash)" class="git-commit-body">{{ commitBodies.get(entry.hash) }}</pre>
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
                <span class="git-log-quote" title="添加到对话" @click.stop="$emit('add-file-to-chat', file.path)">
                  <el-icon :size="12"><ChatDotRound /></el-icon>
                </span>
              </div>
            </template>
            <div v-else class="git-commit-files-state">该提交没有文件变更</div>
          </div>
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
import { ArrowDown, ArrowRight, ChatDotRound, Share } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { GitChangedFile, GitLogEntry, GitRemoteInfo } from '../../types/git'
import { formatRelativeTime, parseRefsDecorations, type RefDecoration } from '../../utils/git-manager'
import { GRAPH_MAX_LANES, computeGitGraph, parseMergeTitle } from '../../utils/git-graph'
import { copyText } from '../../utils/clipboard'
import GitGraphCell from './GitGraphCell.vue'

const props = defineProps<{
  entries: GitLogEntry[]
  loading?: boolean
  error?: string
  exhausted?: boolean
  expandedCommit?: string | null
  commitFiles?: Map<string, GitChangedFile[]>
  /** 提交正文缓存（%B 去首行标题，空串 = 无正文不渲染）。 */
  commitBodies?: Map<string, string>
  commitFilesLoading?: boolean
  remotes?: GitRemoteInfo[]
  pathFilter?: string
  keyword?: string
  /** 历史范围：true = 全部本地 / 远端分支与标签 */
  allBranches?: boolean
}>()

const emit = defineEmits<{
  'load-more': []
  retry: []
  'toggle-commit': [hash: string]
  'open-commit-diff': [payload: { hash: string; file: GitChangedFile }]
  'update:pathFilter': [value: string]
  'update:keyword': [value: string]
  'update:allBranches': [value: boolean]
  'add-file-to-chat': [path: string]
  'add-commit-to-chat': [text: string]
}>()

const remoteNames = computed(() => (props.remotes ?? []).map((r) => r.name))

const graphEnabled = computed(() => !props.pathFilter?.trim() && !props.keyword?.trim())
const graph = computed(() => (graphEnabled.value && props.entries.length > 0 ? computeGitGraph(props.entries) : null))
const graphLanes = computed(() => Math.min(graph.value?.laneCount ?? 1, GRAPH_MAX_LANES))

/** 合并提交：认识的默认合并标题简化为「A → B」，否则原文（仍按合并样式弱化）。 */
function mergeTitle(entry: GitLogEntry): string {
  return parseMergeTitle(entry.title) ?? (entry.title || '（无标题）')
}

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
  font-size: var(--git-fs-row, 13px);
}

.git-error p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--git-fs-meta, 12px);
  font-weight: 500;
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

/* 上下不留 padding：图谱列需撑满行高，相邻行的连线才能首尾相接 */
.git-log-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 0 12px;
  cursor: pointer;
  font-size: var(--git-fs-row, 13px);
}

.git-log-list.has-graph .git-log-row {
  border-bottom: none;
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
  font-size: var(--git-fs-code, 11px);
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

.git-log-title.is-merge {
  color: var(--aw-ink-muted-64);
}

.git-log-merge-icon {
  margin-right: 4px;
  vertical-align: -1px;
  color: var(--aw-ink-muted-48);
}

.git-log-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 50%;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink-muted-48);
}

.git-log-author {
  max-width: 90px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-log-date {
  flex-shrink: 0;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.git-log-ref {
  padding: 0 5px;
  border-radius: 7px;
  font-size: var(--git-fs-code, 11px);
  font-weight: 500;
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

.git-commit-expand {
  display: flex;
  background: var(--aw-canvas-parchment);
}

.git-commit-files {
  flex: 1;
  min-width: 0;
  padding: 2px 12px 8px 30px;
}

.git-log-list.has-graph .git-commit-expand {
  padding-left: 12px;
}

.git-log-list.has-graph .git-commit-files {
  padding-left: 18px;
}

.git-commit-files-state {
  padding: 6px 0;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink-muted-48);
}

.git-commit-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--aw-radius-xs);
  font-size: var(--git-fs-meta, 12px);
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
  font-family: var(--aw-font-mono);
  font-size: 10px;
  font-weight: 700;
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
  color: var(--aw-ink);
}

.git-commit-file-stat {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-family: var(--aw-font-mono);
  font-size: var(--git-fs-code, 11px);
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
  font-size: var(--git-fs-meta, 12px);
  font-weight: 500;
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
  font-size: var(--git-fs-meta, 12px);
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

.git-history-filters {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.git-filter-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 10px;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink);
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s, background-color 0.15s;
}

.git-filter-input:focus {
  border-color: var(--aw-primary);
  background: var(--aw-surface);
  box-shadow: 0 0 0 3px var(--aw-primary-ring);
}

.git-filter-input::placeholder {
  color: var(--aw-ink-muted-40);
}

.git-filter-toggle {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink-muted-64);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.git-filter-toggle input {
  margin: 0;
  accent-color: var(--aw-primary);
  cursor: pointer;
}

.git-graph-hint {
  padding: 4px 12px;
  font-size: var(--git-fs-meta, 12px);
  color: var(--aw-ink-muted-48);
  border-bottom: 1px solid var(--aw-divider-soft);
}

/* 行级「添加到对话」：hover 显现，不改变行高与布局 */
.git-log-quote {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  opacity: 0;
  cursor: pointer;
  transition: opacity 0.15s, color 0.15s;
}

.git-log-main:hover .git-log-quote,
.git-commit-file:hover .git-log-quote {
  opacity: 1;
}

.git-log-quote:hover {
  color: var(--aw-primary);
}

.git-commit-body {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  font-family: inherit;
  font-size: var(--git-fs-meta, 12px);
  line-height: 1.6;
  color: var(--aw-ink-muted-80);
  white-space: pre-wrap;
  word-break: break-word;
}

[data-theme="dark"] .git-commit-body {
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--aw-hairline);
}
</style>
