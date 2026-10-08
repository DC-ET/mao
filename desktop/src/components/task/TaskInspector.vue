<template>
  <div ref="panelEl" class="task-inspector" :class="{ collapsed: panelCollapsed }" :style="panelStyle">
    <template v-if="!panelCollapsed">
    <div class="resize-handle" @mousedown="onResizeStart" @touchstart.prevent="onResizeStart"></div>

    <div v-if="showTabBar" class="inspector-tabs">
      <button
        class="inspector-tab"
        :class="{ active: inspectorActiveTab === 'workspace' }"
        @click="inspectorActiveTab = 'workspace'"
      >
        任务
      </button>
      <button
        v-if="showFileTreeTab"
        class="inspector-tab"
        :class="{ active: inspectorActiveTab === 'filetree' }"
        @click="inspectorActiveTab = 'filetree'"
      >
        文件
      </button>
      <button
        v-if="showGitTab"
        class="inspector-tab"
        :class="{ active: inspectorActiveTab === 'git' }"
        @click="inspectorActiveTab = 'git'"
      >
        Git
      </button>
    </div>

    <div v-show="inspectorActiveTab === 'workspace'" class="inspector-tab-content">
      <div class="inspector-section task-info-section">
        <div class="task-info-top">
          <div class="task-title-group">
            <input
              v-if="editing"
              ref="editInput"
              v-model="editingTitle"
              class="task-title-input"
              @keydown.enter="confirmEdit"
              @keydown.escape="cancelEdit"
              @blur="confirmEdit"
            />
            <div v-else class="task-title-row">
              <h3
                class="task-title"
                :class="{ readonly: viewType === 'subagent' }"
                @click="startEdit"
              >{{ displayTitle }}</h3>
            </div>
          </div>
        </div>
        <div class="task-status-row">
          <span class="phase-badge" :class="phaseClass">
            <span v-if="phase === 'RUNNING'" class="phase-spinner"></span>
            {{ phaseLabel }}
          </span>
          <el-tooltip
            v-if="showContextDrawer"
            :content="contextDisplay ? contextTooltip : '查看上下文详情'"
            placement="top"
            :show-after="300"
          >
            <button type="button" class="context-badge" @click="openContextDrawer">
              {{ contextDisplay ? `上下文 ${contextDisplay}` : '上下文' }}
            </button>
          </el-tooltip>
        </div>
      </div>

      <div v-if="workspace || agentName" class="inspector-section">
        <h4 class="section-title">工作区</h4>
        <div v-if="agentName" class="task-workspace-row">
          <el-icon class="workspace-icon"><User /></el-icon>
          <span class="workspace-path">{{ agentName }}</span>
        </div>
        <div v-if="workspace || executionMode === 'CLOUD'" class="task-workspace-row">
          <el-icon class="workspace-icon"><FolderOpened /></el-icon>
          <span
            class="workspace-path-wrap"
            @mouseenter="workspaceHovered = true"
            @mouseleave="workspaceHovered = false"
          >
            <span class="workspace-path">{{ workspaceLabel }}</span>
            <button
              v-if="executionMode !== 'CLOUD' && workspace"
              class="workspace-copy-btn"
              :class="{ visible: workspaceHovered }"
              @click="copyWorkspace"
              title="复制路径"
            >
              <el-icon :size="12"><DocumentCopy /></el-icon>
            </button>
          </span>
        </div>
        <div v-if="gitSummaryVisible" class="task-workspace-row git-summary-row">
          <el-icon class="workspace-icon"><Share /></el-icon>
          <span class="git-summary">
            <template v-if="multiRepoMode">
              <template v-if="changedRepos.length > 0">
                <button
                  v-for="repo in changedRepos"
                  :key="repo.path"
                  class="git-repo-item"
                  :title="`查看 ${repo.name} 的变更`"
                  @click="handleRepoClick(repo.path)"
                >
                  <span class="git-repo-name">{{ repo.name }}</span>
                  <span class="git-repo-meta">
                    <span class="git-repo-branch">{{ repo.branch || 'HEAD' }}</span>
                    <span class="git-stat git-repo-stat">
                      <span class="git-add">+{{ repo.insertions }}</span>
                      <span class="git-del">-{{ repo.deletions }}</span>
                    </span>
                  </span>
                </button>
              </template>
              <span v-else-if="reposLoading" class="git-muted">检测 Git…</span>
              <span v-else-if="unavailableRepos.length > 0" class="git-muted">{{ repos.length }} 个仓库 · {{ unavailableRepos.length }} 个不可用</span>
              <span v-else class="git-clean">{{ repos.length }} 个仓库 · 全部干净</span>
              <span v-if="unavailableRepos.length > 0 && changedRepos.length > 0" class="git-unavailable-note">{{ unavailableRepos.length }} 个仓库状态不可用</span>
            </template>
            <template v-else>
              <template v-if="gitStatus?.isGit">
                <span class="git-branch">{{ gitStatus.branch || 'HEAD' }}</span>
                <span v-if="gitStatus.changedFileCount === 0" class="git-clean">工作区干净</span>
                <span v-else class="git-stat">
                  <span class="git-add">+{{ gitStatus.insertions }}</span>
                  <span class="git-del">-{{ gitStatus.deletions }}</span>
                </span>
              </template>
              <span v-else-if="gitLoading" class="git-muted">检测 Git…</span>
              <span v-else-if="gitError || reposError" class="git-muted">Git 状态不可用</span>
            </template>
          </span>
        </div>
      </div>

      <div class="inspector-section">
        <h4 class="section-title">进度</h4>
        <TodoChecklist :todos="todos" />
      </div>

      <div class="inspector-section">
        <h4 class="section-title">边路任务</h4>
        <SideTaskList
          :tasks="sideTasks"
          :list-mode="listMode"
          @open-side-task="handleOpenSideTask"
          @edit-title="handleEditSideTaskTitle"
          @delete-side-task="handleDeleteSideTask"
          @promote-side-task="handlePromoteSideTask"
        />
      </div>

      <div class="inspector-section">
        <h4 class="section-title">子代理</h4>
        <SubagentList
          :tasks="subagents"
          @open-subagent="handleOpenSubagent"
        />
      </div>
    </div>

    <div v-if="showFileTreeTab && inspectorActiveTab === 'filetree'" class="inspector-tab-content file-tree-tab">
      <FileTree
        :workspace="workspace || ''"
        :execution-mode="executionMode"
        :provider="fileProvider"
        @open-file="handleOpenFile"
        @add-file-to-chat="$emit('add-file-to-chat', $event)"
      />
    </div>

    <div v-if="showGitTab && inspectorActiveTab === 'git'" class="inspector-tab-content git-tab">
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
      <div v-if="selectedRepo?.unavailable" class="git-state">
        <p>该仓库 Git 状态不可用</p>
        <button class="git-retry" @click="() => refreshAll()">重试</button>
      </div>
      <GitChangeList
        v-else
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
        :operation="gitOperation"
        :execution-mode="executionMode"
        :workspace="workspace"
        :repo-path="multiRepoMode ? selectedRepoPath : undefined"
        :provider="fileProvider"
        @refresh="refreshAll"
        @commit="runGitOperation('commit')"
        @pull="runGitOperation('pull')"
        @push="runGitOperation('push')"
        @open-diff="handleOpenGitDiff"
        @add-file-to-chat="$emit('add-file-to-chat', $event)"
      />
    </div>

    </template>

    <el-drawer
      v-model="contextDrawerOpen"
      class="context-drawer"
      title="上下文详情"
      size="min(420px, calc(100vw - 32px))"
      :with-header="true"
    >
      <div class="context-drawer-body">
        <div class="ctx-block ctx-capacity">
          <div class="ctx-capacity-head">
            <span class="ctx-block-title">上下文容量</span>
            <el-tooltip
              content="本轮真实发送内容的估算总量（消息 + 工具定义），与下方构成合计同口径；压缩后会重新计算"
              placement="top"
              :show-after="300"
            >
              <span v-if="capacitySummary" class="ctx-capacity-value">{{ capacitySummary }}</span>
            </el-tooltip>
          </div>
          <div v-if="waterLevelPct != null" class="ctx-track">
            <div
              class="ctx-track-fill"
              :class="`is-${waterTone}`"
              :style="{ width: waterLevelPct + '%' }"
            ></div>
          </div>
          <div v-else class="ctx-empty">暂无水位数据</div>
          <div v-if="waterLevelPct != null" class="ctx-capacity-foot">
            估算口径 · 与上方容量同口径合计
          </div>
        </div>

        <div class="ctx-block">
          <div class="ctx-block-title ctx-row">
            <span>上下文构成</span>
            <el-tooltip
              content="各节 token 为字节估算口径；分节合计与上方容量同口径（均含系统工具），差异仅来自 system 消息固定开销"
              placement="top"
            >
              <span class="ctx-help">?</span>
            </el-tooltip>
          </div>
          <div v-if="sectionRows.length" class="ctx-sections">
            <div v-for="row in sectionRows" :key="row.key" class="ctx-section-row">
              <span class="ctx-dot" :class="`ctx-dot-${row.rank}`"></span>
              <span class="ctx-section-label">
                {{ row.label }}<span v-if="row.count != null" class="ctx-section-count">· {{ row.count }}</span>
              </span>
              <span class="ctx-section-value">
                <span class="ctx-section-pct">{{ row.pct != null ? `${row.pct}%` : '--' }}</span>
                <span class="ctx-section-tokens" :title="`${row.tokens.toLocaleString()} tokens`">
                  {{ formatTokenCompact(row.tokens) }}
                </span>
              </span>
            </div>
          </div>
          <div v-else class="ctx-empty">本次会话尚无构成数据（发起一次任务后可见）</div>
        </div>

        <div class="ctx-block">
          <div class="ctx-block-title ctx-row">
            <span>本会话注入记忆</span>
            <el-switch
              :model-value="!memoryInjectionDisabled"
              :loading="memoryToggleBusy"
              size="small"
              @update:model-value="toggleMemoryInjection(!Boolean($event))"
            />
          </div>
          <div class="ctx-hint">开关改动将于下次任务开始时生效</div>
          <div v-if="memoryIds.length" class="ctx-memory-chips">
            <button
              v-for="id in memoryIds"
              :key="id"
              class="ctx-chip"
              :title="memorySnippet(id)"
              @click="gotoMemorySettings"
            >{{ memorySnippet(id) }}</button>
          </div>
          <div v-else-if="memoryInjectionDisabled" class="ctx-empty">已关闭本会话记忆注入</div>
          <div v-else class="ctx-empty">本次未注入长期记忆</div>
        </div>

        <div class="ctx-block">
          <div class="ctx-block-title">手动整理上下文</div>
          <button class="ctx-compact-btn" :disabled="isCompacting || compactSubmitting" @click="handleCompactNow">
            {{ isCompacting ? '正在整理上下文…' : '立即整理上下文' }}
          </button>
          <div v-if="isRunning" class="ctx-hint">任务运行中，将在本轮工具结束后执行</div>
          <button class="ctx-summary-toggle" @click="toggleSummaryPanel">
            {{ summaryPanelOpen ? '收起上次摘要' : '查看上次摘要' }}
          </button>
          <div v-if="summaryPanelOpen" class="ctx-summary-panel">
            <div v-if="summaryLoading" class="ctx-empty">加载中…</div>
            <template v-else-if="compactionSummary">
              <div class="ctx-summary-meta">
                <span v-if="compactionSummary.compactCount != null">已整理 {{ compactionSummary.compactCount }} 次</span>
                <span v-if="compactionSummary.compactModel">{{ compactionSummary.compactModel }}</span>
                <span v-if="compactionSummary.updatedAt">{{ compactionSummary.updatedAt }}</span>
              </div>
              <pre class="ctx-summary-text">{{ compactionSummary.summaryText || '（无摘要正文）' }}</pre>
            </template>
            <div v-else class="ctx-empty">暂无压缩摘要记录</div>
          </div>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { FolderOpened, DocumentCopy, User, Share } from '@element-plus/icons-vue'
import { ElMessage, ElTooltip } from 'element-plus'
import TodoChecklist from './TodoChecklist.vue'
import SideTaskList from './SideTaskList.vue'
import SubagentList from './SubagentList.vue'
import GitChangeList from './GitChangeList.vue'
import FileTree from '../file-browser/FileTree.vue'
import type { TodoItem } from '../../types/chat'
import type { SideTaskItem, SubagentItem, TaskPhase } from '../../stores/session'
import type { ContextWindowInfo } from '../../types/chat'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { WorkspaceGitProvider } from '../../composables/workspace-git-provider'
import { useGitStatus } from '../../composables/useGitStatus'
import { useGitRepos } from '../../composables/useGitRepos'
import { useModelContext } from '../../composables/useModelContext'
import { useStreamWS } from '../../composables/useStreamWS'
import { listMemories, getSessionCompaction, setSessionMemoryInjectionDisabled } from '../../api'
import type { SessionCompactionSummary } from '../../api'
import type { GitChangedFile } from '../../types/git'
import { cloudWorkspaceIndicator } from '../../utils/cloud-project'
import { copyText } from '../../utils/clipboard'
import { useSessionStore } from '../../stores/session'

const props = defineProps<{
  todos?: TodoItem[]
  sideTasks?: SideTaskItem[]
  subagents?: SubagentItem[]
  title: string
  agentName?: string
  workspace?: string
  projectKey?: string
  executionMode?: string
  sessionId?: string
  fileProvider: WorkspaceFileProvider | null
  listMode?: 'standard' | 'focus'
  gitProvider?: WorkspaceGitProvider | null
  phase: TaskPhase
  panelCollapsed: boolean
  contextWindow?: ContextWindowInfo | null
  /** 当前展示对象：chat=主会话 / side_task=边路任务 / subagent=子代理 */
  viewType?: 'chat' | 'side_task' | 'subagent'
  /** 当前展示会话的模型 id（上下文占比分母优先使用，缺失回退主会话模型） */
  modelId?: number
}>()

const emit = defineEmits<{
  togglePanel: []
  rename: [title: string]
  'open-file': [payload: { path: string; title: string }]
  'add-file-to-chat': [filePath: string]
  'open-side-task': [payload: { sideSessionId: number; title: string }]
  'open-subagent': [payload: { childSessionId: number; title: string }]
  'edit-title': [payload: { sideSessionId: number; title: string }]
  'delete-side-task': [sideSessionId: number]
  'promote-side-task': [sideSessionId: number]
  'open-git-diff': [file: GitChangedFile, repoPath?: string]
}>()

const sessionStore = useSessionStore()

// Get current session's modelId — 子会话场景优先使用 TaskView 传入的 modelId
const currentModelId = computed(() => {
  if (props.modelId != null) return props.modelId
  if (!props.sessionId) return undefined
  const session = sessionStore.sessions.find(s => String(s.id) === String(props.sessionId))
  return session?.modelId
})

// Get model's max context window tokens
const { maxTokens } = useModelContext(currentModelId)

const inspectorActiveTab = ref<'workspace' | 'filetree' | 'git'>('workspace')
const contextDrawerOpen = ref(false)
const showFileTreeTab = computed(() => {
  if (props.executionMode === 'CLOUD') {
    return !!props.sessionId
  }
  return !!props.workspace
})

const gitProviderRef = computed(() => props.gitProvider ?? null)
const gitEnabled = computed(() => !!props.gitProvider)

// 多仓库模式：发现一级子目录 git 仓库 + 维护选中仓库
const {
  repos,
  multiRepoMode,
  changedRepos,
  unavailableRepos,
  selectedRepoPath,
  selectedRepo,
  loading: reposLoading,
  error: reposError,
  refresh: refreshRepos,
  selectRepo,
} = useGitRepos(gitProviderRef)

// 多仓库模式下按选中仓库包装 provider（单仓库直接透传）
const statusProviderRef = computed<WorkspaceGitProvider | null>(() => {
  const p = gitProviderRef.value
  if (!p) return null
  if (multiRepoMode.value && selectedRepoPath.value) {
    return {
      getRepos: () => p.getRepos(),
      getStatus: () => p.getStatus(selectedRepoPath.value),
      refreshStatus: () => p.refreshStatus(selectedRepoPath.value),
      getFileDiff: (relativePath: string) => p.getFileDiff(relativePath, selectedRepoPath.value),
      commit: () => p.commit(selectedRepoPath.value),
      pull: () => p.pull(selectedRepoPath.value),
      push: () => p.push(selectedRepoPath.value),
    }
  }
  return p
})

const {
  loading: gitLoading,
  error: gitError,
  status: gitStatus,
  files: gitFiles,
  refresh: refreshGit,
  refreshRemote: refreshGitRemote,
} = useGitStatus(statusProviderRef, { enabled: gitEnabled })

// 切换仓库（statusProviderRef 变化）时立即清空旧仓库文件列表：
// 避免窗口期「新 repoPath + 旧文件路径」打开 diff 导致内容错位，并让列表显示加载占位
watch(statusProviderRef, () => {
  gitFiles.value = []
})

const showGitTab = computed(() => {
  if (!props.gitProvider) return false
  if (multiRepoMode.value) return true
  if (gitStatus.value?.isGit) return true
  // Confirmed non-git: never show, even during a refresh
  if (gitStatus.value && !gitStatus.value.isGit) return false
  // Only show while the initial probe is in flight (status still unknown)
  return gitLoading.value
})

// 上下文详情抽屉：任何有会话 id 的可检视对象都能打开（水位/构成/记忆/手动治理随该会话）
const showContextDrawer = computed(() => !!props.sessionId && props.viewType !== 'subagent')

const showTabBar = computed(() => showFileTreeTab.value || showGitTab.value)

const gitSummaryVisible = computed(() => {
  if (!props.gitProvider) return false
  if (multiRepoMode.value) return true
  if (gitStatus.value?.isGit) return true
  if (gitLoading.value && gitStatus.value === null) return true
  // 仓库发现 / 状态读取失败时给出可见提示，避免 Git 信息静默消失
  if (reposError.value || gitError.value) return true
  return false
})

/** 手动刷新 / 任务阶段结束自动刷新：先刷仓库列表与选中项，再刷选中仓库状态。 */
async function refreshAll(remote = true) {
  await refreshRepos()
  if (gitEnabled.value) {
    if (remote) await refreshGitRemote()
    else await refreshGit()
  }
}

const gitOperation = ref<'commit' | 'pull' | 'push' | null>(null)

async function runGitOperation(operation: 'commit' | 'pull' | 'push') {
  const provider = statusProviderRef.value
  if (!provider || gitOperation.value) return
  gitOperation.value = operation
  try {
    const result = await provider[operation]()
    if (result.success) {
      const message = operation === 'commit' && result.commitHash && result.commitTitle
        ? `提交成功 ${result.commitHash}：${result.commitTitle}`
        : result.message || `${operation === 'pull' ? '拉取' : '推送'}成功`
      ElMessage.success(message)
    } else {
      ElMessage.error(result.error || 'Git 操作失败')
    }
  } catch (error) {
    const err = error as Error & { toastShown?: boolean }
    if (!err.toastShown) ElMessage.error(err.message || 'Git 操作失败')
  } finally {
    gitOperation.value = null
    await refreshAll()
  }
}

function handleRepoSelect(path: string) {
  selectRepo(path)
}

function handleRepoClick(path: string) {
  // selectRepo 返回是否选中成功：仓库已删除/不在列表时（方案5过期窗口）不切 tab，避免展示与点击目标错位
  if (selectRepo(path)) {
    inspectorActiveTab.value = 'git'
  }
}

// ===== 上下文透视抽屉（技术方案 5.2 / 5.3 / 5.5） =====
const router = useRouter()
const streamWS = useStreamWS()

function openContextDrawer() {
  contextDrawerOpen.value = true
}

const contextManifest = computed(() => props.contextWindow?.manifest ?? null)
const sectionStats = computed(() => contextManifest.value?.sections ?? [])
const memoryIds = computed(() => contextManifest.value?.memoryIds ?? [])

// 占比分母优先取 manifest 生效窗口，回退模型窗口 / contextWindow.maxTokens
const effectiveWindowTokens = computed<number | null>(() =>
  contextManifest.value?.estimatedWindowTokens
  ?? maxTokens.value
  ?? props.contextWindow?.maxTokens
  ?? null,
)
function tokensPct(tokens: number): number | null {
  const w = effectiveWindowTokens.value
  if (!w || w <= 0) return null
  return Math.min(100, Math.round((tokens / w) * 100))
}
const waterLevelPct = computed(() => tokensPct(props.contextWindow?.estimated ?? 0))

// 水位色调：<60% 常规，60–85% 提示，>85% 告警（与截图的三段式语义一致）
const waterTone = computed(() => {
  const pct = waterLevelPct.value
  if (pct == null) return 'calm'
  if (pct >= 85) return 'alert'
  if (pct >= 60) return 'warn'
  return 'calm'
})

// 容量摘要：20.2万/26万（79%）口径，取分段着色时的两种数字的折中：估算/窗口 + 百分比
const capacitySummary = computed(() => {
  const pct = waterLevelPct.value
  const used = contextTokens.value
  const window = effectiveWindowTokens.value
  if (pct == null || window == null) return ''
  return `${formatTokenCompact(used)}/${formatTokenCompact(window)}（${pct}%）`
})

// 构成行：按占比倒序（占比高的更靠前），并给出色阶档位，方便一眼看到主要占用
type SectionRow = {
  key: string
  label: string
  tokens: number
  count?: number
  pct: number | null
  /** 色阶档位：0/1/2 取主色三档，3 取弱化色 */
  rank: number
}
const sectionRows = computed<SectionRow[]>(() => {
  const rows = sectionStats.value.map((sec, i) => ({
    key: sec.key,
    label: sec.label,
    tokens: sec.tokens,
    count: sec.count,
    pct: tokensPct(sec.tokens),
    rank: i,
  }))
  rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
  rows.forEach((row, i) => { row.rank = i })
  return rows
})

// 记忆条目 snippet：manifest 仅带 id，按 id 调列表接口本地匹配 content（技术方案 5.3）
const memorySnippetById = ref<Map<number, string>>(new Map())
const memoriesLoading = ref(false)
async function loadMemorySnippets() {
  const ids = memoryIds.value.slice()
  const sid = props.sessionId
  if (!ids.length || memoriesLoading.value) return
  memoriesLoading.value = true
  try {
    const page = await listMemories({ pageSize: 200 })
    if (String(props.sessionId) !== String(sid)) return
    const wanted = new Set(ids)
    const map = new Map<number, string>()
    for (const item of page.records ?? []) {
      if (wanted.has(item.id)) map.set(item.id, item.content)
    }
    memorySnippetById.value = map
  } catch {
    // snippet 拉取失败不影响 chip 展示，chip 回退显示 id
  } finally {
    if (String(props.sessionId) === String(sid)) memoriesLoading.value = false
  }
}
function memorySnippet(id: number): string {
  const text = memorySnippetById.value.get(id)
  if (!text) return `记忆 #${id}`
  return text.length > 24 ? text.slice(0, 24) + '…' : text
}
function gotoMemorySettings() {
  router.push('/settings/memory')
}

// 记忆注入开关：读会话 VO 的 memoryInjectionDisabled（下一次执行生效，故只做本地即时回显 + PATCH）
const currentSession = computed(() =>
  props.sessionId ? sessionStore.sessions.find(s => String(s.id) === String(props.sessionId)) : undefined,
)
const memoryInjectionDisabled = computed(() => currentSession.value?.memoryInjectionDisabled ?? false)
const memoryToggleBusy = ref(false)
async function toggleMemoryInjection(disabled: boolean) {
  const sid = props.sessionId
  if (!sid || memoryToggleBusy.value) return
  memoryToggleBusy.value = true
  try {
    await setSessionMemoryInjectionDisabled(sid, disabled)
    sessionStore.updateSession(sid, { memoryInjectionDisabled: disabled })
  } catch (e) {
    ElMessage.error((e as Error)?.message || '切换记忆注入失败')
  } finally {
    memoryToggleBusy.value = false
  }
}

// 手动整理上下文
const isRunning = computed(() =>
  ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'].includes(props.phase),
)
const isCompacting = computed(() => (props.sessionId ? sessionStore.isSessionCompacting(props.sessionId) : false))
const compactSubmitting = ref(false)
async function handleCompactNow() {
  const sid = props.sessionId
  if (!sid || compactSubmitting.value || isCompacting.value) return
  compactSubmitting.value = true
  try {
    await streamWS.compactNow(sid)
  } catch {
    ElMessage.error('发送整理请求失败')
  } finally {
    // 去抖防连点（服务端 signal 幂等，重复点击不叠加）；终态由 compaction_start/end 事件驱动
    setTimeout(() => { compactSubmitting.value = false }, 800)
  }
}

// 上次压缩摘要：折叠面板懒加载
const summaryPanelOpen = ref(false)
const summaryLoaded = ref(false)
const summaryLoading = ref(false)
const compactionSummary = ref<SessionCompactionSummary | null>(null)
async function loadCompactionSummary() {
  const sid = props.sessionId
  if (!sid) return
  summaryLoading.value = true
  try {
    const summary = await getSessionCompaction(sid)
    if (String(props.sessionId) !== String(sid)) return
    compactionSummary.value = summary
  } catch {
    if (String(props.sessionId) !== String(sid)) return
    ElMessage.error('读取压缩摘要失败')
    compactionSummary.value = null
  } finally {
    if (String(props.sessionId) === String(sid)) {
      summaryLoading.value = false
      summaryLoaded.value = true
    }
  }
}
function toggleSummaryPanel() {
  summaryPanelOpen.value = !summaryPanelOpen.value
  if (summaryPanelOpen.value && !summaryLoaded.value && !summaryLoading.value) void loadCompactionSummary()
}

// 切换会话先于 snippet 补拉：清空上一会话缓存后，下面的 watch 才能看到空 map 并重拉。
watch(() => props.sessionId, () => {
  summaryPanelOpen.value = false
  summaryLoaded.value = false
  summaryLoading.value = false
  compactionSummary.value = null
  memoriesLoading.value = false
  memorySnippetById.value = new Map()
})

// 打开抽屉、切换会话或记忆 id 变化时按需补拉 snippet。
// 以 id 列表而不是条数为源：新旧会话条数相同也要重拉。
watch([contextDrawerOpen, () => props.sessionId, () => memoryIds.value.join(',')], () => {
  if (contextDrawerOpen.value && memoryIds.value.length > 0 && memorySnippetById.value.size === 0) {
    void loadMemorySnippets()
  }
})

watch([showFileTreeTab, showGitTab], () => {
  if (inspectorActiveTab.value === 'filetree' && !showFileTreeTab.value) {
    inspectorActiveTab.value = 'workspace'
  }
  if (inspectorActiveTab.value === 'git' && !showGitTab.value) {
    inspectorActiveTab.value = 'workspace'
  }
})

// 切换会话后关闭抽屉：内容属于被切换走的会话，继续开着会让治理动作打到错误会话上
watch(() => props.sessionId, () => {
  contextDrawerOpen.value = false
})

watch(inspectorActiveTab, (tab) => {
  if (tab === 'git') {
    // 方案5：切 Tab 只刷新选中仓库明细，不重复扫描仓库列表（挂载/手动/阶段结束才全量）
    if (gitEnabled.value) void refreshGit()
  }
})

const ACTIVE_GIT_REFRESH_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
const TERMINAL_GIT_REFRESH_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

watch(() => props.phase, (phase, oldPhase) => {
  if (!oldPhase || !props.gitProvider) return
  if (ACTIVE_GIT_REFRESH_PHASES.has(oldPhase) && TERMINAL_GIT_REFRESH_PHASES.has(phase)) {
    void refreshAll(false)
  }
})

// Side tasks share the main session's workspace — when one of them finishes,
// the git status may have changed even though the main session phase hasn't.
watch(
  () => (props.sideTasks ?? []).map((t) => `${t.id}:${t.phase}`).join('|'),
  (_sig, oldSig) => {
    if (!oldSig || !props.gitProvider) return
    const oldPhases = new Map<number, string>(
      oldSig.split('|').filter(Boolean).map((part) => {
        const sep = part.indexOf(':')
        return [Number(part.slice(0, sep)), part.slice(sep + 1)]
      })
    )
    const finished = (props.sideTasks ?? []).some((t) => {
      const oldPhase = oldPhases.get(t.id)
      if (!oldPhase) return false
      return ACTIVE_GIT_REFRESH_PHASES.has(oldPhase) && TERMINAL_GIT_REFRESH_PHASES.has(t.phase)
    })
    if (finished) void refreshAll(false)
  }
)

function handleOpenFile(payload: { path: string; title: string }) {
  emit('open-file', payload)
}

function handleOpenGitDiff(file: GitChangedFile) {
  emit('open-git-diff', file, multiRepoMode.value ? selectedRepoPath.value : undefined)
}

function handleOpenSideTask(payload: { sideSessionId: number; title: string }) {
  emit('open-side-task', payload)
}

function handleOpenSubagent(payload: { childSessionId: number; title: string }) {
  emit('open-subagent', payload)
}

function handleEditSideTaskTitle(payload: { sideSessionId: number; title: string }) {
  emit('edit-title', payload)
}

function handleDeleteSideTask(sideSessionId: number) {
  emit('delete-side-task', sideSessionId)
}

function handlePromoteSideTask(sideSessionId: number) {
  emit('promote-side-task', sideSessionId)
}

const editing = ref(false)
const editingTitle = ref('')
const editInput = ref<HTMLInputElement>()

function startEdit() {
  if (props.viewType === 'subagent') return
  editingTitle.value = props.title || ''
  editing.value = true
  nextTick(() => {
    editInput.value?.focus()
    editInput.value?.select()
  })
}

function confirmEdit() {
  if (!editing.value) return
  const title = editingTitle.value.trim()
  if (title && title !== props.title) {
    emit('rename', title)
  }
  editing.value = false
}

function cancelEdit() {
  editing.value = false
}

const phaseLabel = computed(() => {
  switch (props.phase) {
    case 'RUNNING': return '执行中'
    case 'WAITING_APPROVAL': return '待审批'
    case 'COMPLETED': return '已完成'
    case 'FAILED': return '失败'
    default: return ''
  }
})

const phaseClass = computed(() => {
  switch (props.phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
})

const displayTitle = computed(() => props.title || '新任务')

const workspaceLabel = computed(() => {
  if (props.executionMode === 'CLOUD') {
    // 话题多会话下 sessionTitle 是话题标题而非群名，工作区标签不读会话标题。
    return cloudWorkspaceIndicator(props.executionMode, props.workspace, props.projectKey)
  }
  return props.workspace || ''
})

const workspaceHovered = ref(false)

function copyWorkspace() {
  if (props.workspace) {
    copyText(props.workspace)
  }
}

function formatTokenCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value < 1000) return `${Math.round(value)}`
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(value / 1000)}k`
}

const contextTokens = computed(() => {
  if (!props.contextWindow) return 0
  // estimated = 服务端活跃上下文（锚点+增量）；actual = 最近一次真实 prompt_tokens
  // 取较大值，避免增量阶段被偏小的 stale actual 压住占比
  const estimated = props.contextWindow.estimated || 0
  const actual = props.contextWindow.actual || 0
  const tokens = Math.max(estimated, actual)
  return tokens > 0 ? tokens : 0
})

const contextPercentage = computed(() => {
  if (!contextTokens.value || !maxTokens.value) return null
  return (contextTokens.value / maxTokens.value) * 100
})

const contextDisplay = computed(() => {
  if (!contextTokens.value) return ''
  if (contextPercentage.value !== null) {
    return `${Math.round(contextPercentage.value)}%`
  }
  // Fallback: show only tokens if maxTokens is not available
  return formatTokenCompact(contextTokens.value)
})

const contextTooltip = computed(() => {
  if (!contextTokens.value) return ''
  if (maxTokens.value) {
    return `${formatTokenCompact(contextTokens.value)}/${formatTokenCompact(maxTokens.value)}`
  }
  return formatTokenCompact(contextTokens.value)
})

const panelEl = ref<HTMLElement | null>(null)
const panelWidth = ref<number | null>(null)
const MIN_WIDTH = 120
const MAX_WIDTH = 480

const panelStyle = computed(() => {
  if (panelWidth.value !== null) {
    return { width: `${panelWidth.value}px` }
  }
  return {}
})

function getClientX(e: MouseEvent | TouchEvent): number {
  return 'touches' in e ? e.touches[0].clientX : e.clientX
}

function onResizeStart(e: MouseEvent | TouchEvent) {
  e.preventDefault()
  const startX = getClientX(e)
  const startWidth = panelWidth.value ?? (panelEl.value?.offsetWidth ?? 280)

  function onMove(ev: MouseEvent | TouchEvent) {
    const newWidth = startWidth - (getClientX(ev) - startX)
    panelWidth.value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth))
  }

  function onEnd() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onEnd)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onEnd)
  document.addEventListener('touchmove', onMove)
  document.addEventListener('touchend', onEnd)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
</script>

<style scoped>
.task-inspector {
  position: relative;
  width: var(--aw-inspector-width, 280px);
  flex-shrink: 0;
  border-left: 1px solid var(--aw-divider-soft);
  overflow: hidden;
  background: var(--aw-canvas);
  display: flex;
  flex-direction: column;
}

.task-inspector.collapsed {
  display: none;
}

.inspector-tabs {
  display: flex;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.inspector-tab {
  flex: 1;
  padding: 8px 12px;
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}

.inspector-tab:hover {
  color: var(--aw-ink);
}

.inspector-tab.active {
  color: var(--aw-primary);
  border-bottom-color: var(--aw-primary);
}

.inspector-tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.inspector-tab-content.file-tree-tab,
.inspector-tab-content.git-tab {
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.inspector-section {
  margin-bottom: 20px;
}

.section-title {
  margin: 0 0 8px;
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.5px;
  text-transform: uppercase;
}

.resize-handle {
  position: absolute;
  top: 0;
  left: -8px;
  width: 16px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
}

.resize-handle::before {
  content: '';
  width: 2px;
  height: 32px;
  border-radius: 1px;
  background: var(--aw-hairline);
  transition: background 0.15s, height 0.15s;
}

.resize-handle:hover,
.resize-handle:active {
  background: var(--aw-primary-hover);
}

.resize-handle:hover::before,
.resize-handle:active::before {
  background: var(--aw-primary);
  height: 48px;
}

@media (max-width: 768px), (pointer: coarse) {
  .resize-handle {
    width: 44px;
    left: -22px;
  }

  .resize-handle::before {
    width: 6px;
    height: 56px;
    border-radius: 3px;
  }

  .resize-handle:hover::before,
  .resize-handle:active::before {
    width: 8px;
    height: 72px;
  }
}

.task-info-section {
  border-bottom: 1px solid var(--aw-divider-soft);
  padding-bottom: 12px;
}

.task-info-top {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
}

.task-title-group {
  min-width: 0;
  flex: 1;
}

.task-title-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.task-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
  word-break: break-word;
  cursor: pointer;
}

.task-title.readonly {
  cursor: default;
}

.task-title-input {
  width: 100%;
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 2px 6px;
  outline: none;
  box-sizing: border-box;
}

.task-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.task-workspace-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  margin-bottom: 8px;
}

.task-workspace-row .workspace-icon {
  color: var(--aw-ink-muted-48);
  flex-shrink: 0;
  transform: translateY(1px);
}

.workspace-path-wrap {
  position: relative;
  display: inline;
  line-height: 18px;
}

.task-workspace-row .workspace-path {
  color: var(--aw-ink);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  word-break: break-all;
}

.git-summary {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--aw-text-caption);
  line-height: 18px;
}

.git-repo-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 1px 0;
  cursor: pointer;
  font-size: var(--aw-text-caption);
  line-height: 18px;
  width: 100%;
  text-align: left;
}

.git-repo-item:hover .git-repo-name {
  color: var(--aw-primary);
}

.git-repo-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
}

.git-repo-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.git-repo-branch {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--aw-font-mono);
  color: var(--aw-ink-muted-48);
}

.git-repo-count,
.git-repo-stat {
  flex-shrink: 0;
  margin-left: auto;
}

.git-repo-count {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink-muted-48);
}

.git-unavailable-note {
  width: 100%;
  color: var(--aw-ink-muted-48);
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

.git-branch {
  font-family: var(--aw-font-mono);
  color: var(--aw-ink);
  word-break: break-all;
}

.git-stat {
  font-family: var(--aw-font-mono);
  display: inline-flex;
  gap: 6px;
}

.git-add { color: var(--aw-diff-add); }
.git-del { color: var(--aw-diff-del); }
.git-clean,
.git-muted {
  color: var(--aw-ink-muted-48);
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

.workspace-copy-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
  vertical-align: middle;
  margin-left: 4px;
}

.workspace-copy-btn.visible {
  opacity: 1;
}

.workspace-copy-btn:hover {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.phase-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--aw-text-caption);
  padding: 3px 10px;
  border-radius: var(--aw-radius-md);
  letter-spacing: -0.224px;
}

.phase-badge.running {
  color: var(--aw-primary);
  background: var(--aw-primary-hover);
}

.phase-badge.waiting {
  color: var(--aw-status-waiting);
  background: var(--aw-status-waiting-bg);
}

.phase-badge.completed {
  color: var(--aw-success);
  background: rgba(52, 199, 89, 0.08);
}

.phase-badge.failed {
  color: var(--aw-danger);
  background: rgba(255, 59, 48, 0.08);
}

.phase-badge.idle {
  display: none;
}

.phase-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--aw-primary-line);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: inspector-spin 0.8s linear infinite;
}

@keyframes inspector-spin {
  to { transform: rotate(360deg); }
}

.context-badge {
  display: inline-flex;
  align-items: center;
  font-size: var(--aw-text-caption);
  font-family: var(--aw-font-mono);
  letter-spacing: -0.224px;
  padding: 3px 10px;
  border-radius: var(--aw-radius-md);
  color: var(--aw-ink-muted-48);
  background: rgba(0, 0, 0, 0.04);
  border: none;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}

.context-badge:hover {
  color: var(--aw-primary);
  background: var(--aw-primary-hover);
}

.inspector-tab-content::-webkit-scrollbar {
  width: 4px;
}

.inspector-tab-content::-webkit-scrollbar-track {
  background: transparent;
}

.inspector-tab-content::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

[data-theme="dark"] .task-inspector {
  background: var(--aw-canvas);
}

[data-theme="dark"] .git-repo-select-row {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .inspector-tabs {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .task-info-section {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .workspace-copy-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--aw-primary);
}

[data-theme="dark"] .context-badge {
  color: var(--aw-ink-muted-48);
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .context-badge:hover {
  color: var(--aw-primary);
  background: var(--aw-primary-hover);
}

/* ===== 上下文透视抽屉 ===== */
.context-drawer-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.ctx-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ctx-block-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink, #1f2937);
}
.ctx-block-title.ctx-row {
  justify-content: space-between;
}
.ctx-help {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  font-size: 11px;
  line-height: 1;
  color: var(--aw-ink-muted-48, #9ca3af);
  background: color-mix(in srgb, var(--aw-ink-muted-48, #9ca3af) 16%, transparent);
  cursor: help;
}
.ctx-hint {
  font-size: 12px;
  color: var(--aw-ink-muted-48, #6b7280);
}
.ctx-empty {
  font-size: 12px;
  color: var(--aw-ink-muted-48, #9ca3af);
}
/* --- 容量条：上方一行数值 + 一条粗轨道（三段式色调） --- */
.ctx-capacity-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ctx-capacity-value {
  font-family: var(--aw-font-mono);
  font-size: 12px;
  color: var(--aw-ink-muted-64, #5c5c5c);
  cursor: help;
  border-bottom: 1px dashed color-mix(in srgb, var(--aw-ink-muted-48, #86868b) 50%, transparent);
  padding-bottom: 1px;
}
.ctx-track {
  height: 8px;
  border-radius: 4px;
  background: var(--aw-surface-hover, #f5f5f7);
  overflow: hidden;
}
.ctx-track-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.25s ease, background 0.25s ease;
}
.ctx-track-fill.is-calm {
  background: var(--aw-primary, #0066cc);
}
.ctx-track-fill.is-warn {
  background: var(--aw-warning, #ff9f0a);
}
.ctx-track-fill.is-alert {
  background: var(--aw-danger, #ff3b30);
}
.ctx-capacity-foot {
  font-size: 11px;
  color: var(--aw-ink-muted-40, #999);
  line-height: 1.5;
}
/* --- 构成：圆点 + 标签 + 占比/token，紧凑行 --- */
.ctx-sections {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ctx-section-row {
  display: grid;
  grid-template-columns: 8px 1fr auto;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 13px;
}
.ctx-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  align-self: center;
  background: var(--aw-primary, #0066cc);
}
.ctx-dot-0 { background: var(--aw-primary, #0066cc); }
.ctx-dot-1 { background: color-mix(in srgb, var(--aw-primary, #0066cc) 68%, transparent); }
.ctx-dot-2 { background: color-mix(in srgb, var(--aw-primary, #0066cc) 40%, transparent); }
.ctx-dot-3,
.ctx-dot-4,
.ctx-dot-5 { background: var(--aw-ink-muted-40, #999); }
.ctx-section-label {
  color: var(--aw-ink, #1d1d1f);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-section-count {
  margin-left: 2px;
  font-size: 11px;
  color: var(--aw-ink-muted-48, #86868b);
}
.ctx-section-value {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  white-space: nowrap;
}
.ctx-section-pct {
  min-width: 42px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--aw-ink, #1d1d1f);
}
.ctx-section-tokens {
  font-size: 11px;
  color: var(--aw-ink-muted-48, #86868b);
  font-variant-numeric: tabular-nums;
}
.ctx-memory-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ctx-chip {
  max-width: 100%;
  padding: 3px 8px;
  font-size: 12px;
  border: 1px solid var(--aw-border, #e5e7eb);
  border-radius: 12px;
  background: transparent;
  color: var(--aw-ink, #1f2937);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-chip:hover {
  border-color: var(--aw-primary, #2563eb);
  color: var(--aw-primary, #2563eb);
}
.ctx-compact-btn {
  align-self: flex-start;
  padding: 6px 14px;
  font-size: 13px;
  border: none;
  border-radius: 6px;
  background: var(--aw-primary, #2563eb);
  color: #fff;
  cursor: pointer;
}
.ctx-compact-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ctx-summary-toggle {
  align-self: flex-start;
  padding: 4px 0;
  font-size: 12px;
  border: none;
  background: transparent;
  color: var(--aw-primary, #2563eb);
  cursor: pointer;
}
.ctx-summary-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--aw-border, #e5e7eb);
  border-radius: 8px;
}
.ctx-summary-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11px;
  color: var(--aw-ink-muted-48, #6b7280);
}
.ctx-summary-text {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.5;
  color: var(--aw-ink, #1f2937);
}

[data-theme="dark"] .ctx-block-title {
  color: var(--aw-ink, #e5e7eb);
}
[data-theme="dark"] .ctx-capacity-value {
  color: var(--aw-ink-muted-64, #a1a1a6);
}
[data-theme="dark"] .ctx-section-label {
  color: var(--aw-ink, #e5e7eb);
}
[data-theme="dark"] .ctx-summary-text {
  color: var(--aw-ink, #e5e7eb);
}
</style>
