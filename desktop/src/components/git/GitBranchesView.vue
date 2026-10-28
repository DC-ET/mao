<template>
  <div class="git-branches-view">
    <div v-if="error && branches.length === 0" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('retry')">重试</button>
    </div>
    <div v-else-if="loading && branches.length === 0" class="git-state">加载中…</div>
    <div v-else-if="branches.length === 0" class="git-state">暂无分支</div>
    <template v-else>
      <div v-if="localBranches.length > 0" class="git-branch-group">
        <div class="git-branch-group-head">本地分支 · {{ localBranches.length }}</div>
        <div v-for="branch in localBranches" :key="branch.name" class="git-branch-row">
          <div class="git-branch-main">
            <span class="git-branch-name" :class="{ current: branch.isCurrent }">
              <span v-if="branch.isCurrent" class="git-branch-check">✓</span>{{ branch.name }}
            </span>
            <span v-if="branch.upstream" class="git-branch-upstream">→ {{ branch.upstream }}</span>
            <span class="git-branch-counts">
              <span v-if="(branch.ahead ?? 0) > 0" class="git-ahead">↑{{ branch.ahead }}</span>
              <span v-if="(branch.behind ?? 0) > 0" class="git-behind">↓{{ branch.behind }}</span>
            </span>
            <span v-if="branch.lastCommitHash" class="git-branch-commit">
              <span class="git-branch-commit-hash">{{ branch.lastCommitHash.slice(0, 7) }}</span>
              <span class="git-branch-commit-title" :title="branch.lastCommitTitle">{{ branch.lastCommitTitle || '' }}</span>
            </span>
          </div>
          <button
            class="git-branch-switch"
            :disabled="branch.isCurrent || switching"
            @click="$emit('switch', branch.name, false)"
          >{{ branch.isCurrent ? '当前' : '切换' }}</button>
        </div>
      </div>
      <div v-if="remoteBranches.length > 0" class="git-branch-group">
        <div class="git-branch-group-head">远端分支 · {{ remoteBranches.length }}</div>
        <div v-for="branch in remoteBranches" :key="branch.name" class="git-branch-row">
          <div class="git-branch-main">
            <span class="git-branch-name is-remote">{{ branch.name }}</span>
            <span v-if="branch.lastCommitHash" class="git-branch-commit">
              <span class="git-branch-commit-hash">{{ branch.lastCommitHash.slice(0, 7) }}</span>
              <span class="git-branch-commit-title" :title="branch.lastCommitTitle">{{ branch.lastCommitTitle || '' }}</span>
            </span>
          </div>
          <button class="git-branch-switch" :disabled="switching" @click="$emit('switch', branch.name, true)">跟踪并切换</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { GitBranchInfo } from '../../types/git'

const props = defineProps<{
  branches: GitBranchInfo[]
  loading?: boolean
  error?: string
  /** 切换操作进行中：全部切换按钮禁用（防重入由 useGitOperations 兜底，这里做视觉反馈） */
  switching?: boolean
}>()

const emit = defineEmits<{
  retry: []
  switch: [name: string, create: boolean]
}>()

const localBranches = computed(() => props.branches.filter((b) => !b.isRemote))
const remoteBranches = computed(() => props.branches.filter((b) => b.isRemote))
</script>

<style scoped>
.git-branches-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
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

.git-branch-group {
  padding-bottom: 8px;
}

.git-branch-group-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 8px 12px 4px;
  font-size: var(--aw-text-fine);
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--aw-ink-muted-48);
  background: var(--aw-surface);
}

.git-branch-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 18px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.git-branch-row:hover {
  background: var(--aw-canvas-parchment);
}

.git-branch-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--aw-text-caption);
}

.git-branch-name {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

.git-branch-name.current {
  font-weight: 700;
  color: var(--aw-primary);
}

.git-branch-name.is-remote {
  color: var(--aw-ink-muted-64);
}

.git-branch-check {
  margin-right: 4px;
}

.git-branch-upstream {
  flex-shrink: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.git-branch-counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 4px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

.git-ahead { color: var(--aw-diff-add); }
.git-behind { color: var(--aw-diff-del); }

.git-branch-commit {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.git-branch-commit-hash {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
}

.git-branch-commit-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-branch-switch {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.git-branch-switch:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.git-branch-switch:disabled {
  opacity: 0.4;
  cursor: default;
}

[data-theme="dark"] .git-branch-row {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-branch-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
</style>
