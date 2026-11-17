<template>
  <div class="git-manager-panel">
    <!-- 仓库区：多仓库模式下拉选择（与侧边栏同款）；工作区自身即 git 仓库时无需任何入口（仅此一个仓库，徽章只是重复工作区名） -->
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
    <div v-else-if="repoName && !isRootGit" class="git-repo-badge-row">
      <span class="git-repo-badge" :title="repoName">{{ repoName }}</span>
    </div>

    <!-- 仓库状态条：分支 / upstream / ahead-behind / 远端状态 + 拉取 / 推送 / 刷新（有远端时顺带 fetch --prune） -->
    <div class="git-status-bar">
      <span
        v-if="gitStatus?.detachedHead || gitStatus?.branch || gitLoading"
        class="git-status-branch"
        :class="{ 'is-detached': gitStatus?.detachedHead, 'is-muted': !gitStatus?.branch && !gitStatus?.detachedHead }"
        :title="gitStatus?.detachedHead ? 'detached HEAD：当前不在任何分支上，提交前请先切换分支' : (gitStatus?.branch || '')"
      >
        <svg class="git-branch-icon" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="4.5" cy="3.5" r="1.75" />
          <circle cx="4.5" cy="12.5" r="1.75" />
          <circle cx="11.5" cy="5.5" r="1.75" />
          <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.25 3-5.25 4" />
        </svg>
        <span class="git-status-branch-name">{{ gitStatus?.branch || (gitStatus?.detachedHead ? 'HEAD' : '读取中…') }}</span>
      </span>
      <template v-if="gitStatus?.isGit && !gitStatus.detachedHead">
        <span v-if="gitStatus.upstream" class="git-status-upstream" :title="`跟踪 ${gitStatus.upstream}`">
          <svg class="git-upstream-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M9 4.5 12.5 8 9 11.5" /></svg>
          {{ gitStatus.upstream }}
        </span>
        <span v-if="(gitStatus.aheadCount ?? 0) > 0 || (gitStatus.behindCount ?? 0) > 0" class="git-status-counts">
          <span v-if="(gitStatus.aheadCount ?? 0) > 0" class="git-ahead" :title="`领先远端 ${gitStatus.aheadCount} 个提交`">↑ {{ gitStatus.aheadCount }}</span>
          <span v-if="(gitStatus.behindCount ?? 0) > 0" class="git-behind" :title="`落后远端 ${gitStatus.behindCount} 个提交`">↓ {{ gitStatus.behindCount }}</span>
        </span>
      </template>
      <span v-if="gitStatus?.isGit" class="git-remote-badge" :class="remoteBadgeState">
        <span class="git-remote-badge-text">{{ remoteBadgeText }}</span>
      </span>
      <!-- 同步操作统一收敛到状态条：拉取 / 推送 / 刷新（含 fetch），变更工具栏不再重复放 -->
      <div class="git-status-actions">
        <template v-if="gitStatus?.isGit">
          <el-tooltip :content="pullDisabledReason || '拉取代码'" placement="top" :show-after="300">
            <span>
              <button class="git-status-btn" :disabled="!!pullDisabledReason" aria-label="拉取代码" @click="runOperation('pull')">
                <el-icon :size="14" :class="{ spinning: operation === 'pull' }"><Download /></el-icon>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip :content="pushDisabledReason || '推送代码'" placement="top" :show-after="300">
            <span>
              <button class="git-status-btn" :disabled="!!pushDisabledReason" aria-label="推送代码" @click="runOperation('push')">
                <el-icon :size="14" :class="{ spinning: operation === 'push' }"><Upload /></el-icon>
              </button>
            </span>
          </el-tooltip>
        </template>
        <button
          class="git-status-btn"
          :disabled="refreshDisabledReason !== ''"
          :title="refreshDisabledReason || refreshTitle"
          aria-label="刷新 Git 状态"
          @click="handleRefreshAndFetch"
        >
          <el-icon :size="14" :class="{ spinning: gitLoading || operation === 'fetch' }"><Refresh /></el-icon>
        </button>
      </div>
    </div>

    <!-- 子导航 -->
    <div class="git-subnav">
      <div class="git-subnav-track" role="tablist">
        <button
          v-for="view in views"
          :key="view.id"
          class="git-subnav-btn"
          :class="{ active: activeView === view.id }"
          role="tab"
          :aria-selected="activeView === view.id"
          @click="activeView = view.id"
        >{{ view.label }}<span v-if="view.id === 'changes' && gitFiles.length > 0" class="git-subnav-count">{{ gitFiles.length }}</span></button>
      </div>
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
        hide-refresh
        hide-sync
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
        :commit-bodies="commitBodies"
        :commit-files-loading="commitFilesLoading"
        :remotes="remotes"
        :path-filter="logPathFilter"
        :keyword="logKeyword"
        @load-more="loadMoreLog"
        @retry="retryLog"
        @toggle-commit="toggleCommit"
        @open-commit-diff="handleOpenCommitDiff"
        @update:path-filter="setLogFilters({ path: $event })"
        @update:keyword="setLogFilters({ keyword: $event })"
        @add-file-to-chat="(p) => $emit('add-file-to-chat', p)"
        @add-commit-to-chat="(t) => $emit('add-commit-to-chat', t)"
      />
      <GitBranchesView
        v-else-if="activeView === 'branches'"
        :branches="branches"
        :loading="branchesLoading"
        :error="branchesError"
        :switching="operation === 'switch'"
        @retry="loadBranches"
        @switch="handleSwitchBranch"
        @compare="handleCompareBranch"
        @create-branch="handleCreateBranch"
      />
      <GitCompareView
        v-else-if="activeView === 'compare'"
        :branches="branches"
        :branches-loading="branchesLoading"
        :branches-error="branchesError"
        :compare-base="compareBase"
        :compare-target="compareTarget"
        :compare-result="compareResult"
        :compare-loading="compareLoading"
        :compare-error="compareError"
        @update:compare-base="compareBase = $event"
        @update:compare-target="compareTarget = $event"
        @retry="loadCompare"
        @retry-branches="loadBranches"
        @open-diff="handleOpenBranchDiff"
      />
      <GitStashView
        v-else-if="activeView === 'stash'"
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
import { Download, Refresh, Upload } from '@element-plus/icons-vue'
import GitChangeList from '../task/GitChangeList.vue'
import GitHistoryView from './GitHistoryView.vue'
import GitBranchesView from './GitBranchesView.vue'
import GitStashView from './GitStashView.vue'
import GitCompareView from './GitCompareView.vue'
import type { WorkspaceGitProvider } from '../../composables/workspace-git-provider'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { GitChangedFile, GitStashAction } from '../../types/git'
import { useGitRepos } from '../../composables/useGitRepos'
import { useGitStatus } from '../../composables/useGitStatus'
import { useGitManager, type GitManagerView } from '../../composables/useGitManager'
import { useGitOperations } from '../../composables/useGitOperations'
import { gitPullDisabledReason, gitPushDisabledReason, type GitSyncState } from '../../utils/git-manager'

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
  'open-branch-diff': [payload: { base: string; target: string; file: GitChangedFile; repoPath?: string }]
  'add-file-to-chat': [filePath: string]
  'add-commit-to-chat': [text: string]
}>()

const views: Array<{ id: GitManagerView; label: string }> = [
  { id: 'changes', label: '变更' },
  { id: 'history', label: '历史' },
  { id: 'branches', label: '分支' },
  { id: 'stash', label: 'Stash' },
  { id: 'compare', label: '对比' },
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
  isRootGit,
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
      compareBranches: (base: string, target: string) => p.compareBranches(base, target, repoPath),
      compareBranchFileDiff: (base: string, target: string, relativePath: string, _oldPath?: string) => p.compareBranchFileDiff(base, target, relativePath, repoPath, _oldPath),
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
  expandedCommit, commitFiles, commitBodies, commitFilesLoading,
  logPathFilter, logKeyword, setLogFilters,
  loadMoreLog, retryLog, toggleCommit,
  branches, branchesLoading, branchesError, loadBranches,
  compareBase, compareTarget, compareResult, compareLoading, compareError, loadCompare,
  stashes, stashesLoading, stashesError, loadStashes,
  remotes, refreshLoadedViews,
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

/**
 * 顶部刷新（合并原「获取远端更新」与工具栏 ↻）：
 * 有远端时先显式 fetch --prune（toast + 活动审计），再全量刷新各面板；
 * 未配置远端的仓库退化为纯本地刷新，与工具栏 ↻ 的原有行为一致。
 */
async function handleRefreshAndFetch() {
  if (operation.value) return
  if (gitStatus.value?.hasRemote) {
    await run('fetch')
  }
  await handleRefreshAll()
}

function handleSwitchBranch(name: string, create: boolean) {
  void run('switch', name, create ? { create: true } : undefined).then(() => handleRefreshAll())
}

/** 新建本地分支（基于当前 HEAD）：与「跟踪并切换」同走 switch/create 通道，成功后全量刷新。 */
function handleCreateBranch(name: string) {
  void run('switch', name, { create: true }).then(() => handleRefreshAll())
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

/** 分支行「对比」：切到对比视图并把该分支预填到目标槽（基准槽不动：不填、也不清空已有值） */
function handleCompareBranch(name: string) {
  compareTarget.value = name
  activeView.value = 'compare'
}

/** 分支对比的单文件 diff：补 repoPath 后交给 TaskView 打开中心 Diff Tab */
function handleOpenBranchDiff(payload: { base: string; target: string; file: GitChangedFile }) {
  emit('open-branch-diff', {
    base: payload.base,
    target: payload.target,
    file: payload.file,
    repoPath: multiRepoMode.value ? selectedRepoPath.value : undefined,
  })
}

const refreshTitle = computed(() =>
  gitStatus.value?.hasRemote ? '刷新并获取远端更新（fetch --prune）' : '刷新 Git 状态',
)

const refreshDisabledReason = computed(() => {
  if (operation.value) return 'Git 操作进行中'
  if (gitLoading.value) return '正在读取 Git 状态'
  if (!gitStatus.value?.isGit) return '当前目录不是 Git 仓库'
  return ''
})

/** 状态条拉取 / 推送的禁用判定输入（与侧边栏变更工具栏同一口径） */
const syncState = computed<GitSyncState>(() => ({
  operation: operation.value,
  loading: gitLoading.value,
  error: gitError.value,
  detachedHead: gitStatus.value?.detachedHead,
  hasRemote: gitStatus.value?.hasRemote,
  remoteStatusAvailable: gitStatus.value?.remoteStatusAvailable,
  remoteStatusError: gitStatus.value?.remoteStatusError,
  upstream: gitStatus.value?.upstream,
  behindCount: gitStatus.value?.behindCount,
  hasHead: gitStatus.value?.hasHead,
  hasCommitsToPush: gitStatus.value?.hasCommitsToPush,
}))

const pullDisabledReason = computed(() => gitPullDisabledReason(syncState.value))
const pushDisabledReason = computed(() => gitPushDisabledReason(syncState.value))

// Tab 切走再切回时 KeepAlive 保活：本地状态刷一次，再确认远端（只读状态条，不打断列表滚动）
onActivated(() => {
  if (gitEnabled.value) void refreshGitWithRemote()
})
</script>

<style scoped>
/* Git 管理器字号三档，子视图引用（侧边栏单独用 GitChangeList 时走各处同值兜底）：
 * row 一级列表主文本 / 空状态；meta 次要信息、二级明细、输入框、按钮；code 等宽标识（hash、ref、增删数）。
 * 等宽字体只用于 code 档：等宽字形同字号下明显偏大，分支名、文件名、仓库名一律用正文字体。 */
.git-manager-panel {
  --git-fs-row: 13px;
  --git-fs-meta: var(--aw-text-fine);
  --git-fs-code: 11px;
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
  padding: 12px 16px 0;
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
  font-size: var(--git-fs-meta);
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
  color: var(--aw-ink);
}

:global(.git-repo-option-branch) {
  flex-shrink: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--aw-ink-muted-48);
}

:global(.git-repo-select-popper .el-select-dropdown__item.is-selected .git-repo-option-name),
:global(.git-repo-select-popper .el-select-dropdown__item.is-selected .git-repo-option-branch) {
  color: var(--aw-primary);
}

.git-repo-badge-row {
  padding: 12px 16px 0;
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
  font-size: var(--git-fs-meta);
}

.git-status-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px 10px;
  flex-shrink: 0;
  font-size: var(--git-fs-meta);
  min-width: 0;
}

.git-status-branch {
  flex-shrink: 1;
  min-width: 0;
  max-width: 40%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px 0 8px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-primary-soft);
  box-shadow: 0 0 0 1px var(--aw-primary-line) inset;
  color: var(--aw-ink);
}

.git-status-branch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--git-fs-meta);
  font-weight: 600;
}

.git-branch-icon {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--aw-primary);
  stroke-width: 1.4;
  stroke-linecap: round;
}

.git-status-branch.is-detached {
  background: var(--aw-status-waiting-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aw-warning) 35%, transparent) inset;
  color: var(--aw-status-waiting);
  cursor: help;
}

.git-status-branch.is-detached .git-branch-icon {
  stroke: var(--aw-status-waiting);
}

.git-status-branch.is-muted {
  background: var(--aw-surface-pearl);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
  color: var(--aw-ink-muted-48);
}

.git-status-branch.is-muted .git-status-branch-name {
  font-weight: 400;
}

.git-status-branch.is-muted .git-branch-icon {
  stroke: var(--aw-ink-muted-40);
}

.git-status-upstream {
  flex-shrink: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  white-space: nowrap;
  font-size: var(--git-fs-meta);
  color: var(--aw-ink-muted-48);
}

.git-upstream-icon {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.7;
}

.git-status-counts {
  flex-shrink: 0;
  display: inline-flex;
  gap: 4px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  font-weight: 600;
}

.git-ahead,
.git-behind {
  padding: 1px 6px;
  border-radius: var(--aw-radius-pill);
  line-height: 14px;
  cursor: help;
}

.git-ahead { color: var(--aw-diff-add); background: var(--aw-diff-add-bg); }
.git-behind { color: var(--aw-diff-del); background: var(--aw-diff-del-bg); }

.git-remote-badge {
  /* 可压缩：状态条右侧有三个图标按钮，窄视口下徽标让位（省略号）而非整行溢出 */
  flex-shrink: 1;
  min-width: 0;
  max-width: 180px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  /* 圆点外圈 3px 光晕会被 overflow 裁掉：左侧留出同宽内边距，再用负外边距抵消位移 */
  padding-left: 3px;
  margin-left: -3px;
  font-size: var(--git-fs-meta, 12px);
  line-height: 16px;
  color: var(--aw-ink-muted-48);
}

.git-remote-badge-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.git-remote-badge::before {
  content: '';
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.git-remote-badge.is-ok::before {
  background: var(--aw-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aw-success) 18%, transparent);
}

/* 确认中：中性色呼吸点，区别于「不可用」的警示色 */
.git-remote-badge.is-pending::before {
  background: var(--aw-ink-muted-40);
  animation: git-pulse 1.2s ease-in-out infinite;
}

.git-remote-badge.is-bad {
  color: var(--aw-status-waiting);
}

.git-remote-badge.is-bad::before {
  background: var(--aw-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--aw-warning) 18%, transparent);
}

@keyframes git-pulse {
  50% { opacity: 0.3; }
}

/* 拉取 / 推送 / 刷新收进一组分段按钮，hairline 描边 + 内分隔线 */
.git-status-actions {
  margin-left: auto;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 2px;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset, 0 1px 2px rgba(0, 0, 0, 0.04);
}

.git-status-actions > span + span,
.git-status-actions > span + .git-status-btn {
  position: relative;
}

.git-status-actions > span + span::before,
.git-status-actions > span + .git-status-btn::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 1px;
  background: var(--aw-divider-soft);
}

.git-status-actions > span {
  display: inline-flex;
}

.git-status-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--aw-ink-muted-64);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.git-status-btn:hover:not(:disabled) {
  background: var(--aw-primary-hover);
  color: var(--aw-primary);
}

.git-status-btn:disabled {
  opacity: 0.32;
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
  padding: 0 16px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

/* 分段控件：浅灰轨道 + 选中项浮起白卡 */
.git-subnav-track {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background: var(--aw-canvas-parchment);
}

.git-subnav-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 14px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: color 0.15s, background-color 0.15s, box-shadow 0.15s;
  white-space: nowrap;
}

.git-subnav-btn:hover:not(.active) {
  color: var(--aw-ink);
}

.git-subnav-btn.active {
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 0 0 0.5px rgba(0, 0, 0, 0.06);
}

.git-subnav-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  font-weight: 600;
  line-height: 16px;
  text-align: center;
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
  font-size: var(--git-fs-row);
}

.git-state p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--git-fs-meta);
  font-weight: 500;
}

[data-theme="dark"] .git-manager-panel {
  background: var(--aw-surface);
}

[data-theme="dark"] .git-subnav {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-repo-badge {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .git-status-actions {
  background: rgba(255, 255, 255, 0.03);
  box-shadow: 0 0 0 1px var(--aw-hairline) inset;
}

[data-theme="dark"] .git-subnav-track {
  background: rgba(255, 255, 255, 0.05);
}

[data-theme="dark"] .git-subnav-btn.active {
  background: rgba(255, 255, 255, 0.1);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
}
</style>
