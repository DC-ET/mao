<template>
  <div class="git-stash-view">
    <div v-if="error && stashes.length === 0" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('retry')">重试</button>
    </div>
    <div v-else-if="loading && stashes.length === 0" class="git-state">加载中…</div>
    <div v-else-if="stashes.length === 0" class="git-state">暂无 stash</div>
    <div v-else class="git-stash-list">
      <div v-for="stash in stashes" :key="stash.ref" class="git-stash-row">
        <div class="git-stash-main">
          <span class="git-stash-ref">{{ stash.ref }}</span>
          <span class="git-stash-message" :title="stash.message">{{ stash.message }}</span>
          <span class="git-stash-date" :title="stash.date">{{ formatRelativeTime(stash.date) }}</span>
        </div>
        <div class="git-stash-actions">
          <button class="git-stash-btn" :disabled="busy" @click="$emit('op', 'apply', stash.ref)">应用</button>
          <button class="git-stash-btn" :disabled="busy" @click="$emit('op', 'pop', stash.ref)">弹出</button>
          <button class="git-stash-btn is-danger" :disabled="busy" @click="confirmDrop(stash.ref)">丢弃</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { GitStashAction, GitStashEntry } from '../../types/git'
import { formatRelativeTime } from '../../utils/git-manager'

const props = defineProps<{
  stashes: GitStashEntry[]
  loading?: boolean
  error?: string
  /** stash 操作进行中：全部按钮禁用 */
  busy?: boolean
}>()

const emit = defineEmits<{
  retry: []
  op: [action: GitStashAction, ref: string]
}>()

const busy = computed(() => props.busy === true)

async function confirmDrop(ref: string) {
  if (busy.value) return
  try {
    await ElMessageBox.confirm(
      `确定丢弃 ${ref}？丢弃后该 stash 无法恢复，其中的变更将永久丢失。`,
      '丢弃确认',
      { type: 'warning', confirmButtonText: '丢弃', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  emit('op', 'drop', ref)
}
</script>

<style scoped>
.git-stash-view {
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

.git-stash-list {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.git-stash-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.git-stash-row:hover {
  background: var(--aw-canvas-parchment);
}

.git-stash-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--aw-text-caption);
}

.git-stash-ref {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 7px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
}

.git-stash-message {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink);
}

.git-stash-date {
  flex-shrink: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  font-variant-numeric: tabular-nums;
}

.git-stash-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.git-stash-btn {
  padding: 3px 9px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.git-stash-btn:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.git-stash-btn.is-danger {
  color: var(--aw-danger);
}

.git-stash-btn.is-danger:hover:not(:disabled) {
  background: rgba(255, 59, 48, 0.08);
}

.git-stash-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

[data-theme="dark"] .git-stash-row {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-stash-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
</style>
