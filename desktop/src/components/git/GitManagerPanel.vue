<template>
  <div class="git-manager-panel">
    <!-- 仓库区：多仓库模式下拉选择（与侧边栏同款），单仓库显示徽章 -->
    <div v-if="multiRepoMode" class="git-repo-select-row">
      <el-select
        :model-value="selectedRepoPath"
        class="git-repo-select"
        popper-class="git-repo-select-popper"
        placeholder="搜索或选择仓库"
        filterable
        :reserve-keyword="false"
        size="small"
        @update:model-value="handleRepoSelect"
      >
        <el-option
          v-for="repo in repos"
          :key="repo.path"
          :label="`${repo.name} · ${repo.branch || 'HEAD'}`"
          :value="repo.path"
        >
          <span class="git-repo-option-name">{{ repo.name }}</span>
          <span class="git-repo-option-branch">{{ repo.branch || 'HEAD' }}</span>
        </el-option>
      </el-select>
    </div>
    <div v-else-if="repoName" class="git-repo-badge-row">
      <span class="git-repo-badge" :title="repoName">{{ repoName }}</span>
    </div>

    <!-- 仓库状态条：分支 / upstream / ahead-behind / 远端状态 + 获取远端更新 -->
    <div class="git-status-bar">
      <span v-if="gitStatus?.detachedHead" class="git-status-branch is-detached" title="detached HEAD：当前不在任何分支上，提交前请先切换分支">
        {{ gitStatus.branch || 'HEAD' }}
      </span>
      <span v-else-if="gitStatus?.branch" class="git-status-branch">{{ gitStatus.branch }}</span>
      <span v-else-if="gitLoading" class="git-status-branch is-muted">读取中…</span>
      <template v-if="gitStatus?.isGit && !gitStatus.detachedHead">
        <span v-if="gitStatus.upstream" class="git-status-upstream">→ {{ gitStatus.upstream }}</span>
        <span class="git-status-counts">
          <span v-if="(gitStatus.aheadCount ?? 0) > 0" class="git-ahead">↑{{ gitStatus.aheadCount }}</span>
          <span v-if="(gitStatus.behindCount ?? 0) > 0" class="git-behind">↓{{ gitStatus.behindCount }}</span>
        </span>
      </template>
      <el-tooltip v-if="gitStatus?.isGit" placement="top" :show-after="300" :content="remoteBadgeTooltip">
        <span
          class="git-remote-badge"
          :class="remoteBadgeState"
          @mouseenter="ensureRemotes"
        >
          {{ remoteBadgeText }}
        </span>
      </el-tooltip>
      <div class="git-status-actions">
        <button
          class="git-fetch-btn"
          :disabled="fetchDisabledReason !== ''"
          :title="fetchDisabledReason || '获取远端更新（fetch --prune）'"
          @click="runFetch"
        >
          <el-icon :size="12" :class="{ spinning: operation === 'fetch' }"><Download /></el-icon>
          获取远端更新
        </button>
      </div>
    </div>

    <!-- 子导航 -->
    <div class="git-subnav">
      <button
        v-for="view in views"
        :key="view.id"
        class="git-subnav-btn"
        :class="{ active: activeView === view.id }"
        @click="activeView = view.id"
      >{{ view.label }}</button>
    </div>

    <!-- 视图区 -->
    <div class="git-view-body">
      <div v-if="selectedRepo?.unavailable" class="git-state">
        <p>该仓库 Git 状态不可用</p>
        <button class="git-retry" @click="handleRefreshAll">重试</button>
      </div>
      <GitChangeList
        v-else-if="activeView === 'changes'"
        :files="gitFiles"
        :loading="gitLoading"
        :error="gitError"
        :has-remote="gitStatus?.hasRemote"
        :has-head="gitStatus?.hasHead"
        :detached-head="gitStatus?.detachedHead"
        :upstream="gitStatus?.upstream"
        :remote-status-available="gitStatus?.remoteStatusAvailable"
        :remote-status-error="gitStatus?.remoteStatusError"
        :ahead-count="gitStatus?.aheadCount"
        :behind-count="gitStatus?.behindCount"
        :has-commits-to-push="gitStatus?.hasCommitsToPush"
        :operation="changesOperation"
        :execution-mode="executionMode"
        :workspace="workspace"
        :repo-path="multiRepoMode ? selectedRepoPath : undefined"
        :provider="fileProvider"
        two-step-commit
        :commit-message="commitDraft"
        :generating="generatingMessage"
        :committing="operation === 'commit-with-message'"
        @refresh="handleRefreshAll"
        @commit="runOperation('commit')"
        @pull="runOperation('pull')"
        @push="runOperation('push')"
        @update:commit-message="commitDraft = $event"
        @generate-commit-message="handleGenerateCommitMessage"
        @commit-with-message="handleCommitWithMessage"
        @open-diff="(file) => $emit('open-git-diff', file, multiRepoMode ? selectedRepoPath : undefined)"
        @add-file-to-chat="(path) => $emit('add-file-to-chat', path)"
      />
      <GitHistoryView
        v-else-if="activeView === 'history'"
        :entries="logEntries"
        :loading="logLoading"
        :error="logError"
        :exhausted="logExhausted"
        :expanded-commit="expandedCommit"
        :commit-files="commitFiles"
        :commit-files-loading="commitFilesLoading"
        :remotes="remotes"
        @load-more="loadMoreLog"
        @retry="retryLog"
        @toggle-commit="toggleCommit"
        @open-commit-diff="handleOpenCommitDiff"
      />
      <GitBranchesView
        v-else-if="activeView === 'branches'"
        :branches="branches"
        :loading="branchesLoading"
        :error="branchesError"
        :switching="operation === 'switch'"
        @retry="loadBranches"
        @switch="handleSwitchBranch"
      />
      <GitStashView
        v-else
        :stashes="stashes"
        :loading="stashesLoading"
        :error="stashesError"
        :busy="operation === 'stash'"
        @retry="loadStashes"
        @op="handleStashOp"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, ref, watch } from 'vue'
import { ElMessage, ElTooltip } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import GitChangeList from '../task/GitChangeList.vue'
import GitHistoryView from './GitHistoryView.vue'
import GitBranchesView from './GitBranchesView.vue'
import GitStashView from './GitStashView.vue'
import type { WorkspaceGitProvider } from '../../composables/workspace-git-provider'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { GitChangedFile, GitStashAction } from '../../types/git'
import { useGitRepos } from '../../composables/useGitRepos'
import { useGitStatus } from '../../composables/useGitStatus'
import { useGitManager, type GitManagerView } from '../../composables/useGitManager'
import { useGitOperations } from '../../composables/useGitOperations'
import { sanitizeRemoteUrl } from '../../utils/git-manager'

const props = defineProps<{
  sessionId: string
  gitProvider: WorkspaceGitProvider | null
  fileProvider?: WorkspaceFileProvider | null
  executionMode?: string
  workspace?: string
}>()

const emit = defineEmits<{
  'open-git-diff': [file: GitChangedFile, repoPath?: string]
  'open-commit-diff': [payload: { hash: string; file: GitChangedFile; repoPath?: string }]
  'add-file-to-chat': [filePath: string]
}>()

const views: Array<{ id: GitManagerView; label: string }> = [
  { id: 'changes', label: '变更' },
  { id: 'history', label: '历史' },
  { id: 'branches', label: '分支' },
  { id: 'stash', label: 'Stash' },
]

const gitProviderRef = computed(() => props.gitProvider ?? null)
const gitEnabled = computed(() => !!props.gitProvider)
/**
 * 大 Tab 打开即确认远端状态（多一次 fetch --prune）：否则首屏永远停在未确认态，
 * 徽标误报「远端不可用」、ahead/behind 仍是本地缓存值。
 * fetch 失败时本地状态照常展示，徽标给出真实失败原因（不改用户数据）。
 */
const confirmRemote = computed(() => true)

const {
  repos,
  multiRepoMode,
  selectedRepoPath,
  selectedRepo,
  refresh: refreshRepos,
  selectRepo,
} = useGitRepos(gitProviderRef)

/** 多仓库模式下按选中仓库包装 provider（单仓库直接透传），与 TaskInspector 同款模式 */
const statusProviderRef = computed<WorkspaceGitProvider | null>(() => {
  const p = gitProviderRef.value
  if (!p) return null
  if (multiRepoMode.value && selectedRepoPath.value) {
    const repoPath = selectedRepoPath.value
    return {
      ...p,
      getStatus: () => p.getStatus(repoPath),
      refreshStatus: () => p.refreshStatus(repoPath),
      getFileDiff: (relativePath: string) => p.getFileDiff(relativePath, repoPath),
      commit: () => p.commit(repoPath),
      generateCommitMessage: () => p.generateCommitMessage(repoPath),
      commitWithMessage: (message: string) => p.commitWithMessage(message, repoPath),
      pull: () => p.pull(repoPath),
      push: () => p.push(repoPath),
      getLog: (opts) => p.getLog(opts, repoPath),
      getCommitFiles: (hash: string) => p.getCommitFiles(hash, repoPath),
      getCommitFileDiff: (hash: string, relativePath: string, _oldPath?: string) => p.getCommitFileDiff(hash, relativePath, repoPath, _oldPath),
      getBranches: () => p.getBranches(repoPath),
      getStashes: () => p.getStashes(repoPath),
      getRemotes: () => p.getRemotes(repoPath),
      fetchRemote: () => p.fetchRemote(repoPath),
      switchBranch: (branch: string, opts?: { create?: boolean }) => p.switchBranch(branch, opts, repoPath),
      stashOp: (action: GitStashAction, ref: string) => p.stashOp(action, ref, repoPath),
    }
  }
  return p
})

const {
  loading: gitLoading,
  error: gitError,
  status: gitStatus,
  files: gitFiles,
  remoteLoading: gitRemoteLoading,
  refreshRemote: refreshGitRemote,
  refreshWithRemoteConfirmation: refreshGitWithRemote,
} = useGitStatus(statusProviderRef, { enabled: gitEnabled, confirmRemote })

const manager = useGitManager(statusProviderRef)
const {
  activeView, logEntries, logLoading, logError, logExhausted,
  expandedCommit, commitFiles, commitFilesLoading,
  loadMoreLog, retryLog, toggleCommit,
  branches, branchesLoading, branchesError, loadBranches,
  stashes, stashesLoading, stashesError, loadStashes,
  remotes, loadRemotes, refreshLoadedViews,
} = manager

const { operation, run } = useGitOperations(statusProviderRef)

/** 变更视图只展示 commit/pull/push 三态的旋转图标，fetch/switch/stash 不属于它的工具栏 */
const changesOperation = computed<'commit' | 'pull' | 'push' | null>(() =>
  operation.value === 'commit' || operation.value === 'pull' || operation.value === 'push'
    ? operation.value
    : null,
)

const repoName = computed(() => {
  if (multiRepoMode.value) return selectedRepo.value?.name || ''
  const root = gitStatus.value?.repoRoot || props.workspace || ''
  if (!root) return ''
  const parts = root.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || root
})

const remoteBadgeTooltip = computed(() => {
  const status = gitStatus.value
  if (!status) return ''
  if (!status.remoteStatusAvailable) {
    // 首屏确认在途（fetch 尚未返回）：这是「还没问过远端」，不是故障
    if (gitRemoteLoading.value && !status.remoteStatusError) return '正在确认远端状态（fetch --prune）…'
    return status.remoteStatusError || '远端状态不可用'
  }
  if (remotes.value.length === 0) return '远端状态可用'
  return remotes.value
    .map((r) => `${r.name}\nfetch: ${sanitizeRemoteUrl(r.fetchUrl)}\npush: ${sanitizeRemoteUrl(r.pushUrl)}`)
    .join('\n\n')
})

/** 徽标三态：确认中（中性）> 可用（绿）> 不可用（橙，带真实原因）。 */
const remoteBadgeState = computed(() => {
  const status = gitStatus.value
  if (!status) return 'is-bad'
  if (status.remoteStatusAvailable) return 'is-ok'
  if (gitRemoteLoading.value && !status.remoteStatusError) return 'is-pending'
  return 'is-bad'
})

const remoteBadgeText = computed(() => {
  const status = gitStatus.value
  if (!status) return '远端不可用'
  if (status.remoteStatusAvailable) return '远端可用'
  if (gitRemoteLoading.value && !status.remoteStatusError) return '确认远端中…'
  return status.remoteStatusError || '远端不可用'
})

function ensureRemotes() {
  void loadRemotes()
}

/** 手动刷新 / 写操作后：刷仓库列表 + 选中仓库状态（含远端）+ 已加载视图数据 */
async function handleRefreshAll() {
  await refreshRepos()
  if (gitEnabled.value) await refreshGitRemote()
  await refreshLoadedViews()
}

function handleRepoSelect(path: string) {
  selectRepo(path)
}

function runOperation(op: 'commit' | 'pull' | 'push') {
  void run(op).then(() => handleRefreshAll())
}

// ===== 两步提交（中央 Git 管理器）：LLM 生成 → 输入框编辑 → 提交 =====
const commitDraft = ref('')
const generatingMessage = ref(false)

async function handleGenerateCommitMessage() {
  const p = statusProviderRef.value
  if (!p || generatingMessage.value) return
  generatingMessage.value = true
  try {
    const generated = await p.generateCommitMessage(multiRepoMode.value ? selectedRepoPath.value : undefined)
    // 生成期间切仓库：迟到的消息不写进新仓库的输入框
    if (p !== statusProviderRef.value) return
    commitDraft.value = generated.message
  } catch (e: any) {
    ElMessage.error(e?.message || '生成提交信息失败')
  } finally {
    generatingMessage.value = false
  }
}

function handleCommitWithMessage() {
  const message = commitDraft.value.trim()
  if (!message) return
  void run('commit-with-message', message).then((result) => {
    if (result?.success) commitDraft.value = ''
    void handleRefreshAll()
  })
}

// 草稿属于当前仓库：切仓库 / 切会话后清空，防止把上一个仓库的提交信息提交到新仓库
watch(statusProviderRef, () => {
  commitDraft.value = ''
})

async function runFetch() {
  if (operation.value) return
  await run('fetch')
  await handleRefreshAll()
}

function handleSwitchBranch(name: string, create: boolean) {
  void run('switch', name, create ? { create: true } : undefined).then(() => handleRefreshAll())
}

function handleStashOp(action: GitStashAction, ref: string) {
  void run('stash', action, ref).then(() => handleRefreshAll())
}

function handleOpenCommitDiff(payload: { hash: string; file: GitChangedFile }) {
  emit('open-commit-diff', {
    hash: payload.hash,
    file: payload.file,
    repoPath: multiRepoMode.value ? selectedRepoPath.value : undefined,
  })
}

const fetchDisabledReason = computed(() => {
  if (operation.value) return 'Git 操作进行中'
  if (gitLoading.value) return '正在读取 Git 状态'
  if (!gitStatus.value?.isGit) return '当前目录不是 Git 仓库'
  if (!gitStatus.value.hasRemote) return '仓库未配置远端'
  return ''
})

// Tab 切走再切回时 KeepAlive 保活：本地状态刷一次，再确认远端（只读状态条，不打断列表滚动）
onActivated(() => {
  if (gitEnabled.value) void refreshGitWithRemote()
})
</script>

<style scoped>
.git-manager-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aw-surface);
}

.git-repo-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-repo-select {
  width: 100%;
  min-width: 0;
}

.git-repo-select :deep(.el-select__wrapper) {
  min-height: 30px;
  padding: 2px 9px 2px 10px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-pearl);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
  transition: background-color 160ms ease, box-shadow 160ms ease;
}

.git-repo-select :deep(.el-select__wrapper:hover) {
  background: var(--aw-surface);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aw-primary) 35%, var(--aw-hairline)) inset;
}

.git-repo-select :deep(.el-select__wrapper.is-focused) {
  background: var(--aw-surface);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--aw-primary) 22%, transparent),
              0 0 0 1px var(--aw-primary) inset;
}

.git-repo-select :deep(.el-select__selected-item),
.git-repo-select :deep(.el-select__input) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

:global(.git-repo-select-popper.el-select__popper) {
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  box-shadow: var(--aw-shadow-product);
  overflow: hidden;
}

:global(.git-repo-select-popper .el-select-dropdown__list) {
  padding: 5px;
}

:global(.git-repo-select-popper .el-select-dropdown__item) {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 9px;
  border-radius: 7px;
  font-size: var(--aw-text-fine);
}

:global(.git-repo-select-popper .el-select-dropdown__item.is-hovering) {
  background: var(--aw-surface-hover);
}

:global(.git-repo-select-popper .el-select-dropdown__item.is-selected) {
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
}

:global(.git-repo-option-name) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

:global(.git-repo-option-branch) {
  flex-shrink: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
}

:global(.git-repo-select-popper .el-select-dropdown__item.is-selected .git-repo-option-name),
:global(.git-repo-select-popper .el-select-dropdown__item.is-selected .git-repo-option-branch) {
  color: var(--aw-primary);
}

.git-repo-badge-row {
  padding: 8px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-repo-badge {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 8px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-pearl);
  color: var(--aw-ink-muted-64);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

.git-status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
  font-size: var(--aw-text-caption);
  min-width: 0;
}

.git-status-branch {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  font-weight: 600;
  color: var(--aw-ink);
}

.git-status-branch.is-detached {
  color: var(--aw-warning);
  cursor: help;
}

.git-status-branch.is-muted {
  font-weight: 400;
  color: var(--aw-ink-muted-48);
}

.git-status-upstream {
  flex-shrink: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.git-status-counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 6px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
}

.git-ahead { color: var(--aw-diff-add); }
.git-behind { color: var(--aw-diff-del); }

.git-remote-badge {
  flex-shrink: 0;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 6px;
  border-radius: 7px;
  font-size: var(--aw-text-fine);
  line-height: 16px;
  cursor: help;
}

.git-remote-badge.is-ok {
  background: rgba(52, 199, 89, 0.1);
  color: var(--aw-success);
}

/* 确认中：中性色，区别于「不可用」的警示色 */
.git-remote-badge.is-pending {
  background: var(--aw-fill-subtle, rgba(120, 120, 128, 0.12));
  color: var(--aw-text-secondary, #8e8e93);
}

.git-remote-badge.is-bad {
  background: rgba(255, 159, 10, 0.12);
  color: var(--aw-warning);
}

.git-status-actions {
  margin-left: auto;
  flex-shrink: 0;
}

.git-fetch-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.git-fetch-btn:hover:not(:disabled) {
  background: var(--aw-primary-hover);
}

.git-fetch-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.spinning {
  animation: git-spin 0.8s linear infinite;
}

@keyframes git-spin {
  to { transform: rotate(360deg); }
}

.git-subnav {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 12px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-subnav-btn {
  padding: 5px 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
  font-weight: 500;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.git-subnav-btn:hover {
  color: var(--aw-ink);
}

.git-subnav-btn.active {
  color: var(--aw-primary);
  border-bottom-color: var(--aw-primary);
}

.git-view-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.git-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.git-state p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

[data-theme="dark"] .git-manager-panel {
  background: var(--aw-surface);
}

[data-theme="dark"] .git-repo-select-row,
[data-theme="dark"] .git-repo-badge-row,
[data-theme="dark"] .git-status-bar,
[data-theme="dark"] .git-subnav {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-repo-badge {
  background: rgba(255, 255, 255, 0.06);
}
</style>
