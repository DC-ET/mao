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
            <h3 v-else class="task-title" @click="startEdit">{{ displayTitle }}</h3>
          </div>
        </div>
        <div class="task-status-row">
          <span class="phase-badge" :class="phaseClass">
            <span v-if="phase === 'RUNNING'" class="phase-spinner"></span>
            {{ phaseLabel }}
          </span>
          <span v-if="contextDisplay" class="context-badge">
            上下文 {{ contextDisplay }}
          </span>
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
            <template v-if="gitStatus?.isGit">
              <span class="git-branch">{{ gitStatus.branch || 'HEAD' }}</span>
              <span v-if="gitStatus.changedFileCount === 0" class="git-clean">工作区干净</span>
              <span v-else class="git-stat">
                <span class="git-add">+{{ gitStatus.insertions }}</span>
                <span class="git-del">-{{ gitStatus.deletions }}</span>
              </span>
            </template>
            <span v-else-if="gitLoading" class="git-muted">检测 Git…</span>
            <span v-else-if="gitError" class="git-muted">Git 状态不可用</span>
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
          @open-side-task="handleOpenSideTask"
          @edit-title="handleEditSideTaskTitle"
          @delete-side-task="handleDeleteSideTask"
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
      <GitChangeList
        :files="gitFiles"
        :loading="gitLoading"
        :error="gitError"
        @refresh="refreshGit"
        @open-diff="handleOpenGitDiff"
      />
    </div>

    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { FolderOpened, DocumentCopy, User, Share } from '@element-plus/icons-vue'
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
import type { GitChangedFile } from '../../types/git'
import { cloudWorkspaceIndicator } from '../../utils/cloud-project'

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
  gitProvider?: WorkspaceGitProvider | null
  phase: TaskPhase
  panelCollapsed: boolean
  contextWindow?: ContextWindowInfo | null
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
  'open-git-diff': [file: GitChangedFile]
}>()

const inspectorActiveTab = ref<'workspace' | 'filetree' | 'git'>('workspace')
const showFileTreeTab = computed(() => {
  if (props.executionMode === 'CLOUD') {
    return !!props.sessionId
  }
  return !!props.workspace
})

const gitProviderRef = computed(() => props.gitProvider ?? null)
const gitEnabled = computed(() => !!props.gitProvider)
const {
  loading: gitLoading,
  error: gitError,
  status: gitStatus,
  files: gitFiles,
  refresh: refreshGit,
} = useGitStatus(gitProviderRef, { enabled: gitEnabled })

const showGitTab = computed(() => {
  if (!props.gitProvider) return false
  if (gitStatus.value?.isGit) return true
  // Confirmed non-git: never show, even during a refresh
  if (gitStatus.value && !gitStatus.value.isGit) return false
  // Only show while the initial probe is in flight (status still unknown)
  return gitLoading.value
})

const showTabBar = computed(() => showFileTreeTab.value || showGitTab.value)

const gitSummaryVisible = computed(() => {
  if (!props.gitProvider) return false
  if (gitStatus.value?.isGit) return true
  if (gitLoading.value && gitStatus.value === null) return true
  return false
})

watch([showFileTreeTab, showGitTab], () => {
  if (inspectorActiveTab.value === 'filetree' && !showFileTreeTab.value) {
    inspectorActiveTab.value = 'workspace'
  }
  if (inspectorActiveTab.value === 'git' && !showGitTab.value) {
    inspectorActiveTab.value = 'workspace'
  }
})

watch(inspectorActiveTab, (tab) => {
  if (tab === 'git') {
    void refreshGit()
  }
})

const ACTIVE_GIT_REFRESH_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])
const TERMINAL_GIT_REFRESH_PHASES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'])

watch(() => props.phase, (phase, oldPhase) => {
  if (!oldPhase || !props.gitProvider) return
  if (ACTIVE_GIT_REFRESH_PHASES.has(oldPhase) && TERMINAL_GIT_REFRESH_PHASES.has(phase)) {
    void refreshGit()
  }
})

function handleOpenFile(payload: { path: string; title: string }) {
  emit('open-file', payload)
}

function handleOpenGitDiff(file: GitChangedFile) {
  emit('open-git-diff', file)
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

const editing = ref(false)
const editingTitle = ref('')
const editInput = ref<HTMLInputElement>()

function startEdit() {
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
    return cloudWorkspaceIndicator(props.executionMode, props.workspace, props.projectKey)
  }
  return props.workspace || ''
})

const workspaceHovered = ref(false)

function copyWorkspace() {
  if (props.workspace) {
    navigator.clipboard.writeText(props.workspace)
  }
}

function formatTokenCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '--'
  if (value < 1000) return `${Math.round(value)}`
  if (value < 10000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${Math.round(value / 1000)}k`
}

const contextDisplay = computed(() => {
  if (!props.contextWindow) return ''
  const tokens = props.contextWindow.actual > 0
    ? props.contextWindow.actual
    : props.contextWindow.estimated
  if (tokens <= 0) return ''
  return formatTokenCompact(tokens)
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
  left: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
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
  background: rgba(0, 102, 204, 0.06);
}

.resize-handle:hover::before,
.resize-handle:active::before {
  background: var(--aw-primary);
  height: 48px;
}

@media (max-width: 768px) {
  .resize-handle {
    width: 20px;
    left: -10px;
  }

  .resize-handle::before {
    width: 3px;
    height: 40px;
  }

  .resize-handle:hover::before,
  .resize-handle:active::before {
    height: 56px;
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
  gap: 4px;
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
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--aw-text-caption);
  line-height: 18px;
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

.git-add { color: #1a7f37; }
.git-del { color: #cf222e; }
.git-clean,
.git-muted {
  color: var(--aw-ink-muted-48);
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
  background: rgba(0, 102, 204, 0.08);
}

.phase-badge.waiting {
  color: #b37400;
  background: rgba(179, 116, 0, 0.08);
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
  border: 1.5px solid rgba(0, 102, 204, 0.2);
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
  border-left-color: var(--aw-hairline);
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
</style>
