<template>
  <div ref="panelEl" class="task-index-panel" :class="{ collapsed, 'actions-hidden': !showItemActions }" :style="panelStyle">
    <template v-if="!collapsed">
      <div class="panel-header">
        <span class="panel-title">任务</span>
        <div class="header-actions">
          <button
            class="refresh-btn mode-toggle-btn"
            :class="{ active: listMode === 'focus' }"
            @click="toggleListMode"
            :title="listMode === 'focus' ? '切换到标准模式' : '切换到聚焦模式'"
            :aria-label="listMode === 'focus' ? '切换到标准模式' : '切换到聚焦模式'"
          >
            <el-icon :size="15">
              <BellFilled v-if="listMode === 'focus'" />
              <Bell v-else />
            </el-icon>
          </button>
          <button class="refresh-btn" @click="refreshSessions" :disabled="loading || focusLoading">
            <el-icon :size="14" :class="{ 'is-loading': loading || focusLoading }"><Refresh /></el-icon>
          </button>
          <button class="refresh-btn" @click="$emit('newTask')" title="新任务">
            <el-icon :size="14"><Plus /></el-icon>
          </button>
        </div>
      </div>
      <div class="panel-content">
        <template v-if="listMode === 'standard'">
          <TaskSessionGroupList
            :loading="loading"
            :grouped-sessions="groupedSessions"
            :drag-over-index="dragOverIndex"
            :drag-index="dragIndex"
            :renaming-group-key="renamingGroupKey"
            v-model:renaming-value="renamingValue"
            :show-item-actions="showItemActions"
            :active-session-id="activeSessionId"
            :confirming-delete-id="confirmingDeleteId"
            :editing-session-id="editingSessionId"
            v-model:editing-title="editingTitle"
            :DEFAULT_VISIBLE="DEFAULT_VISIBLE"
            :toggle-group="toggleGroup"
            :open-group-context-menu="openGroupContextMenu"
            :set-group-rename-input="setGroupRenameInput"
            :on-group-rename-keydown="onGroupRenameKeydown"
            :on-group-rename-blur="onGroupRenameBlur"
            :group-alias-tooltip="groupAliasTooltip"
            :is-group-collapsed="isGroupCollapsed"
            :open-group-folder="openGroupFolder"
            :open-terminal="openTerminal"
            :on-group-new-task="onGroupNewTask"
            :get-visible-count="getVisibleCount"
            :select-session="selectSession"
            :open-context-menu="openContextMenu"
            :has-pending-approval="hasPendingApproval"
            :has-pending-question="hasPendingQuestion"
            :effective-phase-class="effectivePhaseClass"
            :on-edit-keydown="onEditKeydown"
            :on-edit-blur="onEditBlur"
            :has-active-side-task="hasActiveSideTask"
            :has-unread-side-task="hasUnreadSideTask"
            :format-elapsed="formatElapsed"
            :confirm-delete="confirmDelete"
            :cancel-delete="cancelDelete"
            :is-deleting="isDeleting"
            :confirm-edit="confirmEdit"
            :cancel-edit="cancelEdit"
            :start-edit="startEdit"
            :start-delete="startDelete"
            :can-expand-group="canExpandGroup"
            :is-group-loading-more="isGroupLoadingMore"
            :show-more="showMore"
            :show-less="showLess"
            :on-group-drag-start="onGroupDragStart"
            :on-group-drag-over="onGroupDragOver"
            :on-group-drag-leave="onGroupDragLeave"
            :on-group-drop="onGroupDrop"
            :on-group-drag-end="onGroupDragEnd"
          />
        </template>

        <!-- 聚焦模式：全量平铺 + 优先级排序 -->
        <template v-else>
          <TaskFocusList
            :focus-loading="focusLoading"
            :focus-error="focusError"
            :focused-sessions="focusedSessions"
            :visible-focus-main-sessions="visibleFocusMainSessions"
            :focus-main-sessions="focusMainSessions"
            :history-sessions="historySessions"
            :active-session-id="activeSessionId"
            :confirming-delete-id="confirmingDeleteId"
            :editing-session-id="editingSessionId"
            v-model:editing-title="editingTitle"
            :show-item-actions="showItemActions"
            :FOCUS_DEFAULT_VISIBLE="FOCUS_DEFAULT_VISIBLE"
            :FOCUS_EXPAND_STEP="FOCUS_EXPAND_STEP"
            v-model:focus-visible-count="focusVisibleCount"
            v-model:history-collapsed="historyCollapsed"
            :load-focus="loadFocus"
            :select-session="selectSession"
            :open-context-menu="openContextMenu"
            :effective-phase-class="effectivePhaseClass"
            :on-edit-keydown="onEditKeydown"
            :on-edit-blur="onEditBlur"
            :has-active-side-task="hasActiveSideTask"
            :workspace-label="workspaceLabel"
            :focus-status-class="focusStatusClass"
            :focus-status-label="focusStatusLabel"
            :confirm-delete="confirmDelete"
            :cancel-delete="cancelDelete"
            :is-deleting="isDeleting"
            :start-edit="startEdit"
            :start-archive="startArchive"
            :start-delete="startDelete"
            :format-elapsed="formatElapsed"
          />
        </template>

        <!-- 已归档区（两种模式下都显示在底部） -->
        <TaskArchivedSection
          :archive-collapsed="archiveCollapsed"
          :archived-count="archivedCount"
          :archived-loading="archivedLoading"
          :archived-sessions="archivedSessions"
          :active-session-id="activeSessionId"
          :confirming-delete-id="confirmingDeleteId"
          :editing-session-id="editingSessionId"
          v-model:editing-title="editingTitle"
          :show-item-actions="showItemActions"
          :toggle-archive="toggleArchive"
          :load-archive="loadArchive"
          :select-session="selectSession"
          :open-context-menu="openContextMenu"
          :on-edit-keydown="onEditKeydown"
          :on-edit-blur="onEditBlur"
          :workspace-label="workspaceLabel"
          :format-elapsed="formatElapsed"
          :confirm-delete="confirmDelete"
          :cancel-delete="cancelDelete"
          :is-deleting="isDeleting"
          :do-unarchive="doUnarchive"
          :is-archiving="isArchiving"
          :start-edit="startEdit"
          :start-delete="startDelete"
        />
      </div>
    </template>
    <div
      v-if="!collapsed"
      class="resize-handle"
      @mousedown="onResizeStart"
      @touchstart.prevent="onResizeStart"
    ></div>

    <!-- 右键菜单（Teleport 到 body，桌面右键 / 移动端长按） -->
    <TaskContextMenu
      :context-menu="contextMenu"
      :group-context-menu="groupContextMenu"
      :menu-archive="menuArchive"
      :menu-unarchive="menuUnarchive"
      :menu-edit-title="menuEditTitle"
      :menu-delete="menuDelete"
      :menu-share="menuShare"
      :menu-export-jsonl="menuExportJsonl"
      :menu-rename-group="menuRenameGroup"
      :menu-reset-group="menuResetGroup"
      :has-group-alias="hasGroupAlias"
    />

    <ShareDialog v-model="shareVisible" :session-id="shareSessionId" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Refresh, Plus, Bell, BellFilled } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'
import { useTerminal } from '../../composables/useTerminal'
import { removeSessionTabsFor } from '../../composables/useCenterTabs'
import { useTaskPanelPrefs } from '../../composables/useTaskPanelPrefs'
import { useRelativeTime, formatRelativeTime } from '../../composables/useRelativeTime'
import { cloudGroupKey, isEmbedGroupKey, isGroupRenameable, isSharedCloudProject, resolveGroupLabel } from '../../utils/cloud-project'
import { planFocusReveal, planGroupReveal } from '../../utils/taskSidebarReveal'
import { sessionToFocusCandidate, sortByFocusPriority, isHistoryEligible } from '../../utils/focusSort'
import TaskSessionGroupList from './TaskSessionGroupList.vue'
import TaskFocusList from './TaskFocusList.vue'
import TaskArchivedSection from './TaskArchivedSection.vue'
import TaskContextMenu from './TaskContextMenu.vue'
import ShareDialog from './ShareDialog.vue'
import { downloadSessionJsonl } from '../../utils/sessionShare'
import { shouldDismissContextMenuForScroll } from '../../utils/contextMenuDismiss'

const props = defineProps<{
  collapsed: boolean
  listMode?: 'standard' | 'focus'
}>()

const emit = defineEmits<{
  toggle: []
  newTask: []
  'update:listMode': [mode: 'standard' | 'focus']
  newTaskFromGroup: [payload: { agentId: string; executionMode: string; workspace?: string; cloudProjectKey?: string; permissionLevel?: string; modelId?: number }]
}>()

const router = useRouter()
const sessionStore = useSessionStore()
const { createTerminal, isOpen: terminalOpen } = useTerminal()
const { sortGroups, onDragEnd, loadPrefs, isGroupCollapsed, toggleGroupCollapsed, expandGroup, groupAliases, renameGroup, resetGroupAlias } = useTaskPanelPrefs()
useRelativeTime()

const DEFAULT_VISIBLE = 5
const EXPAND_STEP = 20
const FOCUS_DEFAULT_VISIBLE = 20
const FOCUS_EXPAND_STEP = 20
const HISTORY_DAYS = 3

const loading = computed(() => sessionStore.loading)
const focusLoading = computed(() => sessionStore.focusLoading)
const archivedLoading = computed(() => sessionStore.archivedLoading)
const activeSessionId = computed(() => sessionStore.activeSessionId)
const confirmingDeleteId = ref<string | null>(null)
const editingSessionId = ref<string | null>(null)
const editingTitle = ref('')
const expandedCounts = ref<Map<string, number>>(new Map())

// 聚焦模式状态
const focusVisibleCount = ref(FOCUS_DEFAULT_VISIBLE)
const focusError = ref(false)
const historyCollapsed = ref(true)
// 已归档区状态
const archiveCollapsed = ref(true)

// 右键菜单状态
const contextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  sessionId: null as string | null,
  zone: 'standard' as 'standard' | 'archived',
})

// 分组头右键菜单状态
const groupContextMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  key: '',
})

// 分组行内重命名状态（与既有会话重命名交互一致：Enter 提交 / Esc 取消 / 失焦提交 / 空值重置）
const renamingGroupKey = ref<string | null>(null)
const renamingValue = ref('')
let groupRenameInputEl: HTMLInputElement | null = null

function setGroupRenameInput(_key: string, el: unknown) {
  // 只记引用：Vue3 function ref 在每次重渲染都会执行，这里若 focus/select 会吞掉用户输入
  // （运行中会话的 WS 推送会触发列表重渲染）。
  groupRenameInputEl = (el as HTMLInputElement | null) ?? null
}

/** 聚焦模式：全量 ACTIVE 主会话按优先级排序（服务端 tree* 信号 + 实时信号）。 */
const focusedSessions = computed<Session[]>(() => {
  const all = sessionStore.focusedSessions
  const byId = new Map(all.map((s) => [String(s.id), s]))
  return sortByFocusPriority(all.map(sessionToFocusCandidate))
    .map((c) => byId.get(String(c.id)))
    .filter((s): s is Session => !!s)
})

/** 历史折叠：已完成且超过 3 天无更新的任务 */
const historySessions = computed(() => focusedSessions.value.filter(s => isHistoryEligible(s, HISTORY_DAYS)))

const archivedSessions = computed(() => sessionStore.archivedSessions)
const archivedCount = computed(() => {
  let total = 0
  for (const meta of sessionStore.archivedGroupMeta.values()) total += meta.total
  return total > 0 ? total : archivedSessions.value.length
})

/** 聚焦模式使用全量数据，平铺列表不应包含已折叠进历史的已完成任务 */
const focusMainSessions = computed(() => {
  const historyIds = new Set(historySessions.value.map(s => String(s.id)))
  return focusedSessions.value.filter(s => !historyIds.has(String(s.id)))
})

/** 聚焦平铺可见项（默认 20 + 展开更多，只控制渲染数量） */
const visibleFocusMainSessions = computed(() => focusMainSessions.value.slice(0, focusVisibleCount.value))

function toggleListMode() {
  emit('update:listMode', props.listMode === 'focus' ? 'standard' : 'focus')
}

async function loadFocus() {
  focusError.value = false
  try {
    await sessionStore.fetchFocusSessions(true)
  } catch {
    focusError.value = true
  }
}

async function loadArchive(force = false) {
  try {
    await sessionStore.fetchArchivedSessions(force)
  } catch {
    // 静默失败，下次展开重试
  }
}

/** 展开已归档区：首次展开时自动加载（静默）；收起则直接切换。 */
function toggleArchive() {
  archiveCollapsed.value = !archiveCollapsed.value
  if (!archiveCollapsed.value) {
    void loadArchive(true)
  }
}

function openContextMenu(e: MouseEvent, session: Session, zone: 'standard' | 'archived') {
  const menuWidth = 160
  const menuHeight = 200
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
  // 互斥：会话菜单打开时关闭分组菜单，避免两个浮层叠加
  closeGroupContextMenu()
  contextMenu.sessionId = String(session.id)
  contextMenu.zone = zone
  contextMenu.x = Math.max(4, x)
  contextMenu.y = Math.max(4, y)
  contextMenu.visible = true
}

function closeContextMenu() {
  contextMenu.visible = false
}

function menuArchive() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (id) void doArchive(id)
}

function menuUnarchive() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (id) void sessionStore.unarchiveSession(id)
}

function menuEditTitle() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (!id) return
  const session = sessionStore.getSessionEntity(id)
  if (session) startEdit(new MouseEvent('click'), session)
}

function menuDelete() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (!id) return
  // 窄面板（<200px）没有行内确认按钮宿主：改走确认弹窗完成删除
  if (!showItemActions.value) {
    void deleteSessionViaDialog(id)
    return
  }
  confirmingDeleteId.value = id
}

const shareVisible = ref(false)
const shareSessionId = ref('')

function menuShare() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (!id) return
  shareSessionId.value = id
  shareVisible.value = true
}

function menuExportJsonl() {
  const id = contextMenu.sessionId
  closeContextMenu()
  if (id) void downloadSessionJsonl(id)
}

function hasGroupAlias(key: string): boolean {
  return !!groupAliases.value[key]?.trim()
}

/** 存在别名时 tooltip 提示真实推导名，避免用户忘记别名对应的目录/渠道身份。 */
function groupAliasTooltip(key: string): string {
  const alias = groupAliases.value[key]?.trim()
  if (!alias) return ''
  // 推导名需带 group 内 session：飞书/钉钉标签依赖 agentName，缺省会显示「未知 Agent」
  const group = groupedSessions.value.find((g) => g.key === key)
  return `${alias}（${resolveGroupLabel(key, {}, group?.sessions?.[0])}）`
}

function openGroupContextMenu(e: MouseEvent, key: string) {
  if (!isGroupRenameable(key) && !hasGroupAlias(key)) return
  // 互斥：分组菜单打开时关闭会话菜单，避免两个浮层叠加
  closeContextMenu()
  const menuWidth = 140
  const menuHeight = 80
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
  groupContextMenu.key = key
  groupContextMenu.x = Math.max(4, x)
  groupContextMenu.y = Math.max(4, y)
  groupContextMenu.visible = true
}

function menuRenameGroup() {
  const key = groupContextMenu.key
  closeGroupContextMenu()
  if (!key) return
  startGroupRename(key)
}

function menuResetGroup() {
  const key = groupContextMenu.key
  closeGroupContextMenu()
  if (!key) return
  resetGroupAlias(key)
  ElMessage.success('已恢复默认名称')
}

function closeGroupContextMenu() {
  groupContextMenu.visible = false
}

function startGroupRename(key: string) {
  // 顺手关掉可能打开的会话右键菜单，避免两个浮层叠加
  closeContextMenu()
  renamingGroupKey.value = key
  // 预填当前展示名（别名优先，无别名则推导名），与会话重命名预填标题的交互一致。
  // 优先取 groupedSessions 的 label：与分组头同源，且飞书/钉钉推导名带 agentName。
  const group = groupedSessions.value.find((g) => g.key === key)
  renamingValue.value = group?.label ?? resolveGroupLabel(key, groupAliases.value)
  nextTick(() => {
    if (groupRenameInputEl) {
      groupRenameInputEl.focus()
      groupRenameInputEl.select()
    }
  })
}

function onGroupRenameBlur() {
  nextTick(() => {
    if (!renamingGroupKey.value) return
    void confirmGroupRename()
  })
}

async function confirmGroupRename() {
  const key = renamingGroupKey.value
  const value = renamingValue.value.trim()
  if (!key) return
  // 别名保存在本地偏好（renamedGroup 走 300ms 防抖 PUT），无异步失败路径；空值等价于重置。
  if (value) {
    renameGroup(key, value)
  } else if (hasGroupAlias(key)) {
    resetGroupAlias(key)
  }
  renamingGroupKey.value = null
  renamingValue.value = ''
}

function cancelGroupRename() {
  renamingGroupKey.value = null
  renamingValue.value = ''
}

function onGroupRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    void confirmGroupRename()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelGroupRename()
  }
}

/** 窄面板删除兜底：确认弹窗 + 与行内确认相同的删除/跳转逻辑。 */
async function deleteSessionViaDialog(sessionId: string) {
  try {
    await ElMessageBox.confirm('确定删除该任务吗？删除后无法恢复。', '确认删除', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  const wasActive = sessionStore.activeSessionId === sessionId
  const deleted = await sessionStore.deleteSession(sessionId)
  if (!deleted) {
    ElMessage.error('删除失败，请稍后重试')
    return
  }
  // 删除成功后清理该会话的 Tab 状态，避免模块级 Map 无界增长 / 恢复归档时串出旧 Tab
  removeSessionTabsFor(sessionId)
  if (wasActive && sessionStore.sessions.length > 0) {
    const next = sessionStore.sessions[0]
    sessionStore.setActiveSession(next.id)
    router.push(`/tasks/${next.id}`)
  } else if (wasActive) {
    router.push({ name: 'Home', query: { newTask: '1' } })
  }
}

function startArchive(e: MouseEvent, session: Session) {
  e.stopPropagation()
  void doArchive(String(session.id))
}

/** 归档：运行中 / 待审批任务弹确认提示；其余直接归档。 */
async function doArchive(id: string) {
  const entity = sessionStore.getSessionEntity(String(id))
  if (!entity) return
  const busy = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'].includes(entity.phase)
  if (busy) {
    try {
      await ElMessageBox.confirm(
        '任务仍在运行中，归档后完成 / 待审批将不再在主列表提醒，确定归档？',
        '归档确认',
        { confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning' }
      )
    } catch {
      return // 用户取消
    }
  }
  await sessionStore.archiveSession(id)
}

function doUnarchive(id: string) {
  void sessionStore.unarchiveSession(id)
}

function isArchiving(id: string): boolean {
  return sessionStore.isArchiving(String(id))
}

function isDeleting(id: string): boolean {
  return sessionStore.isDeleting(String(id))
}

function workspaceLabel(session: Session): string {
  const key = cloudGroupKey(session)
  return resolveGroupLabel(key, groupAliases.value, session)
}

function focusStatusLabel(session: Session): string {
  // 与排序口径一致：实时增量信号与服务端 tree* 取并集（max）
  const approval = Math.max(
    session.treePendingApprovalCount ?? session.pendingApprovalCount ?? 0,
    sessionStore.sessionPendingApprovals?.get(String(session.id)) ?? 0
  )
  const question = Math.max(
    session.treePendingQuestionCount ?? session.pendingQuestionCount ?? 0,
    sessionStore.sessionPendingQuestions?.get(String(session.id))?.length ?? 0
  )
  const sides = sessionStore.getSideTasks(String(session.id))
  const runningSide = session.treeRunning === false
    ? undefined
    : sides.find(t => SIDE_ACTIVE_PHASES.has(t.phase))
  const failedSide = sides.find(t => t.phase === 'FAILED')
  if (approval > 0) return `待审批${approval > 1 ? ` ×${approval}` : ''}`
  if (question > 0) return '待回答'
  if (session.phase === 'FAILED' || failedSide || session.treeFailed) return '已失败'
  if (session.phase === 'RUNNING') return `运行中 ${formatRelativeTime(session.startedAt || session.updatedAt || session.createdAt)}`
  if (session.phase === 'RESUMING') return '恢复中'
  if (session.phase === 'WAITING_APPROVAL') return '待审批'
  if (session.phase === 'CANCELLING') return '取消中'
  if (runningSide) return `运行中 ${formatRelativeTime(runningSide.startedAt || runningSide.updatedAt || runningSide.createdAt)}`
  if (session.treeRunning) return `运行中 ${formatRelativeTime(session.updatedAt || session.createdAt)}`
  switch (session.phase) {
    case 'COMPLETED': return `${formatRelativeTime(session.updatedAt || session.createdAt)}前完成`
    case 'CANCELLED': return '已取消'
    default: return '空闲'
  }
}

function focusStatusClass(session: Session): string {
  const approval = Math.max(
    session.treePendingApprovalCount ?? session.pendingApprovalCount ?? 0,
    sessionStore.sessionPendingApprovals?.get(String(session.id)) ?? 0
  )
  const question = Math.max(
    session.treePendingQuestionCount ?? session.pendingQuestionCount ?? 0,
    sessionStore.sessionPendingQuestions?.get(String(session.id))?.length ?? 0
  )
  const sides = sessionStore.getSideTasks(String(session.id))
  const hasRunningSide = session.treeRunning === false
    ? false
    : sides.some(t => SIDE_ACTIVE_PHASES.has(t.phase))
  if (approval > 0 || question > 0) return 'status-waiting'
  if (session.phase === 'FAILED' || session.treeFailed || sides.some(t => t.phase === 'FAILED')) return 'status-failed'
  if (session.phase === 'RUNNING' || session.phase === 'RESUMING' || session.phase === 'WAITING_APPROVAL' || session.treeRunning || hasRunningSide) return 'status-running'
  if (session.phase === 'COMPLETED') return 'status-completed'
  return ''
}

// 进入聚焦模式时加载全量数据；已加载则静默刷新
watch(
  () => props.listMode,
  (mode) => {
    if (mode === 'focus') {
      focusVisibleCount.value = FOCUS_DEFAULT_VISIBLE
      void loadFocus()
    }
  }
)

// 点击空白处关闭右键菜单
function onGlobalClick() {
  if (contextMenu.visible) closeContextMenu()
  if (groupContextMenu.visible) closeGroupContextMenu()
}
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (contextMenu.visible) closeContextMenu()
    if (groupContextMenu.visible) closeGroupContextMenu()
  }
}
/**
 * 任务栏滚动或窗口尺寸变化时关闭右键菜单：菜单是 fixed 定位，残留在旧位置会误点中无关会话。
 * 对话区随 Agent 执行贴底滚动也会经 window capture 冒上来，锚点没动，不能关掉菜单。
 */
function onGlobalScroll(e: Event) {
  if (e.type === 'scroll' && !shouldDismissContextMenuForScroll(e.target, panelEl.value)) return
  if (contextMenu.visible) closeContextMenu()
  if (groupContextMenu.visible) closeGroupContextMenu()
}
onMounted(() => {
  document.addEventListener('click', onGlobalClick)
  document.addEventListener('keydown', onGlobalKeydown)
  // capture 捕获面板内部滚动；window resize 同样会使 fixed 坐标失效
  window.addEventListener('scroll', onGlobalScroll, true)
  window.addEventListener('resize', onGlobalScroll)
})
onUnmounted(() => {
  document.removeEventListener('click', onGlobalClick)
  document.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('scroll', onGlobalScroll, true)
  window.removeEventListener('resize', onGlobalScroll)
})

// Drag state
const dragIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)

// Panel resize
const panelEl = ref<HTMLElement | null>(null)
const panelWidth = ref<number | null>(null)
const effectivePanelWidth = ref(280)
const MIN_WIDTH = 120
const MAX_WIDTH = 500
const ACTION_BUTTONS_MIN_WIDTH = 200

const showItemActions = computed(() => effectivePanelWidth.value >= ACTION_BUTTONS_MIN_WIDTH)

let resizeObserver: ResizeObserver | null = null

function updateEffectivePanelWidth() {
  if (panelEl.value) {
    effectivePanelWidth.value = panelEl.value.offsetWidth
  }
}

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
    const newWidth = startWidth + (getClientX(ev) - startX)
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

watch(showItemActions, (show) => {
  if (!show) {
    confirmingDeleteId.value = null
    editingSessionId.value = null
    editingTitle.value = ''
  }
})

onMounted(() => {
  void loadPrefs()
  updateEffectivePanelWidth()
  if (panelEl.value) {
    resizeObserver = new ResizeObserver(() => updateEffectivePanelWidth())
    resizeObserver.observe(panelEl.value)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})

/**
 * 从地址进入会话（飞书卡片「会话详情」、搜索、刷新）时，
 * 展开所在分组、露出默认只显示前几条之外的那一行，并滚到可见区域。
 * 会话还没进列表时先不滚，等它出现再定位一次。
 * 用户随后手动收起分组不会被立刻再展开。
 */
let revealToken = 0

async function revealActiveSession(id: string | null) {
  const token = ++revealToken
  if (!id || props.collapsed) return
  await nextTick()
  if (token !== revealToken) return

  if (props.listMode === 'focus') {
    const plan = planFocusReveal(
      id,
      focusMainSessions.value.map((s) => String(s.id)),
      historySessions.value.map((s) => String(s.id)),
      focusVisibleCount.value,
      historyCollapsed.value,
    )
    if (!plan) {
      if (sessionStore.getSessionEntity(id)?.status === 'ARCHIVED') {
        await revealArchivedSession(id, token)
      }
      return
    }
    if (plan.expandHistory) historyCollapsed.value = false
    if (plan.visibleCount > focusVisibleCount.value) focusVisibleCount.value = plan.visibleCount
  } else {
    const plan = planGroupReveal(
      id,
      groupedSessions.value.map((g) => ({ key: g.key, sessionIds: g.sessions.map((s) => String(s.id)) })),
      isGroupCollapsed,
      getVisibleCount,
    )
    if (!plan) {
      if (sessionStore.getSessionEntity(id)?.status === 'ARCHIVED') {
        await revealArchivedSession(id, token)
      }
      return
    }
    if (plan.expand) expandGroup(plan.groupKey)
    if (plan.visibleCount > getVisibleCount(plan.groupKey)) {
      expandedCounts.value.set(plan.groupKey, plan.visibleCount)
      expandedCounts.value = new Map(expandedCounts.value)
    }
  }

  await nextTick()
  if (token !== revealToken) return
  scrollSessionIntoView(id)
}

async function revealArchivedSession(id: string, token: number) {
  archiveCollapsed.value = false
  if (!archivedSessions.value.some((s) => String(s.id) === String(id))) {
    await loadArchive()
  }
  await nextTick()
  if (token !== revealToken) return
  scrollSessionIntoView(id)
}

function scrollSessionIntoView(sessionId: string) {
  const root = panelEl.value?.querySelector('.panel-content') as HTMLElement | null
  if (!root) return
  const el = root.querySelector(`[data-session-id="${CSS.escape(String(sessionId))}"]`) as HTMLElement | null
  if (!el) return
  const rootRect = root.getBoundingClientRect()
  const elRect = el.getBoundingClientRect()
  if (elRect.top >= rootRect.top && elRect.bottom <= rootRect.bottom) return
  root.scrollTop += elRect.top - rootRect.top - (root.clientHeight - el.offsetHeight) / 2
}

async function onGroupNewTask(group: { sessions: Session[] }) {
  const last = group.sessions[0] // already sorted by updatedAt desc
  if (!last) return
  // Prefer the currently open session in this group (user may have just switched model mid-chat;
  // model switch does not bump updatedAt, so sessions[0] can be a different older session).
  const activeId = activeSessionId.value
  const activeInGroup = activeId
    ? group.sessions.find(s => String(s.id) === String(activeId))
    : undefined
  const source = activeInGroup || last
  emit('newTaskFromGroup', {
    agentId: String(source.agentId),
    executionMode: source.executionMode,
    cloudProjectKey: source.executionMode === 'CLOUD' && isSharedCloudProject(source)
      ? source.projectKey
      : undefined,
    workspace: source.executionMode === 'LOCAL' ? source.workspace : undefined,
    permissionLevel: source.permissionLevel,
    modelId: source.modelId
  })
}

function openGroupFolder(group: { key: string }) {
  // 与同组的 openTerminal 一致给出三端提示：早期静默 return，Web/安卓上点击毫无反应像坏掉
  if (typeof window === 'undefined' || !window.electronAPI?.openFolder) {
    ElMessage.info('在文件浏览器中打开仅在桌面客户端可用')
    return
  }
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (!workspace) return
  window.electronAPI.openFolder(workspace)
}

function openTerminal(group: { key: string }) {
  if (typeof window === 'undefined' || !window.electronAPI?.openTerminal) {
    ElMessage.info('终端仅在桌面客户端可用')
    return
  }
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (!terminalOpen.value) {
    terminalOpen.value = true
  }
  createTerminal(workspace || undefined)
}

const groupedSessions = computed(() => {
  const sessions = sessionStore.sessions
  const groups = new Map<string, Session[]>()

  for (const s of sessions) {
    const key = cloudGroupKey(s)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(s)
  }

  const entries = Array.from(groups.entries())

  entries.sort(([a], [b]) => {
    if (a === 'CLOUD:临时工作区') return -1
    if (b === 'CLOUD:临时工作区') return 1
    if (isEmbedGroupKey(a) !== isEmbedGroupKey(b)) return isEmbedGroupKey(a) ? -1 : 1
    if (a.startsWith('CLOUD:') && !b.startsWith('CLOUD:')) return -1
    if (!a.startsWith('CLOUD:') && b.startsWith('CLOUD:')) return 1
    return a.localeCompare(b)
  })

  const result = entries.map(([key, sessions]) => ({
    key,
    label: resolveGroupLabel(key, groupAliases.value, sessions[0]),
    sessions: sessions.sort((a, b) => {
      if (a.running && !b.running) return -1
      if (!a.running && b.running) return 1
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
      if (tb !== ta) return tb - ta
      // updated_at 相同时按 id 倒序，避免批量更新导致按创建正序排列
      return Number(b.id) - Number(a.id)
    })
  }))

  // 应用自定义排序
  return sortGroups(result)
})

const SIDE_ACTIVE_PHASES = new Set<TaskPhase>(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])

function hasActiveSideTask(sessionId: string): boolean {
  const session = sessionStore.getSessionEntity(String(sessionId))
  if (session?.treeRunning === false) return false
  return sessionStore.getSideTasks(String(sessionId)).some(t => SIDE_ACTIVE_PHASES.has(t.phase))
}

function hasUnreadSideTask(sessionId: string): boolean {
  return sessionStore.getSideTasks(String(sessionId)).some(t => t.unread)
}

function phaseClass(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return 'running'
    case 'WAITING_APPROVAL': return 'waiting'
    case 'COMPLETED': return 'completed'
    case 'FAILED': return 'failed'
    default: return 'idle'
  }
}

function effectivePhaseClass(session: Session): string {
  if (session.running) return phaseClass(session.phase)
  const sides = sessionStore.getSideTasks(String(session.id))
  if (sides.some(t => t.phase === 'WAITING_APPROVAL')) return 'waiting'
  if (session.treeFailed || sides.some(t => t.phase === 'FAILED')) return 'failed'
  const hasRunningSide = session.treeRunning === false
    ? false
    : sides.some(t => SIDE_ACTIVE_PHASES.has(t.phase))
  if (session.treeRunning || hasRunningSide) return 'running'
  return phaseClass(session.phase)
}

function formatElapsed(session: Session) {
  return formatRelativeTime(session.createdAt)
}

async function selectSession(session: Session) {
  if (editingSessionId.value === session.id) return
  confirmingDeleteId.value = null
  editingSessionId.value = null
  if (session.unread) {
    await sessionStore.markAsRead(session.id)
  }
  // 活跃会话由 TaskView 在详情及 workspace/executionMode 同步完成后切换，
  // 避免新 sessionId 短暂搭配旧会话的工作区 provider。
  router.push(`/tasks/${session.id}`)
}

function startDelete(e: MouseEvent, sessionId: string) {
  e.stopPropagation()
  confirmingDeleteId.value = sessionId
}

function cancelDelete(e?: MouseEvent) {
  e?.stopPropagation()
  confirmingDeleteId.value = null
}

async function confirmDelete(e: MouseEvent, sessionId: string) {
  e.stopPropagation()
  if (confirmingDeleteId.value !== sessionId) return
  const wasActive = sessionStore.activeSessionId === sessionId
  confirmingDeleteId.value = null
  const deleted = await sessionStore.deleteSession(sessionId)
  if (!deleted) {
    ElMessage.error('删除失败，请稍后重试')
    return
  }
  // 删除成功后清理该会话的 Tab 状态，避免模块级 Map 无界增长 / 恢复归档时串出旧 Tab
  removeSessionTabsFor(sessionId)
  if (wasActive && sessionStore.sessions.length > 0) {
    const next = sessionStore.sessions[0]
    sessionStore.setActiveSession(next.id)
    router.push(`/tasks/${next.id}`)
  } else if (wasActive) {
    router.push({ name: 'Home', query: { newTask: '1' } })
  }
}

function startEdit(e: MouseEvent, session: Session) {
  e.stopPropagation()
  editingSessionId.value = session.id
  editingTitle.value = session.summary || session.title || ''
  nextTick(() => {
    const input = document.querySelector('.session-title-input') as HTMLInputElement
    if (input) {
      input.focus()
      input.select()
    }
  })
}

function onEditBlur() {
  nextTick(() => {
    if (!editingSessionId.value) return
    const active = document.activeElement
    if (active?.closest('.session-item-actions')) return
    void confirmEdit()
  })
}

async function confirmEdit(e?: MouseEvent) {
  e?.stopPropagation()
  const id = editingSessionId.value
  const title = editingTitle.value.trim()
  if (!id || !title) {
    cancelEdit()
    return
  }
  try {
    await sessionStore.renameSession(id, title)
    editingSessionId.value = null
    editingTitle.value = ''
  } catch {
    // 失败保持编辑态让用户重试；store/拦截器已提示
    ElMessage.error('重命名失败')
  }
}

function cancelEdit(e?: MouseEvent) {
  e?.stopPropagation()
  editingSessionId.value = null
  editingTitle.value = ''
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    confirmEdit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  }
}

function getVisibleCount(key: string): number {
  return expandedCounts.value.get(key) ?? DEFAULT_VISIBLE
}

/** 当前会话是否已出现在对应列表里。列表晚于路由到位时（深链补进行）会再定位一次。 */
function sidebarRevealKey(): string {
  const id = activeSessionId.value
  if (!id || props.collapsed) return ''
  if (props.listMode === 'focus') {
    const inMain = focusMainSessions.value.some((s) => String(s.id) === String(id))
    const inHistory = historySessions.value.some((s) => String(s.id) === String(id))
    return `focus:${id}:${inMain}:${inHistory}:${sessionStore.focusLoaded}`
  }
  const inGroup = groupedSessions.value.some((g) => g.sessions.some((s) => String(s.id) === String(id)))
  const archived = sessionStore.getSessionEntity(id)?.status === 'ARCHIVED'
  return `std:${id}:${inGroup}:${archived}`
}

watch(sidebarRevealKey, () => {
  void revealActiveSession(activeSessionId.value)
})

function canExpandGroup(group: { key: string; sessions: Session[] }): boolean {
  const visible = getVisibleCount(group.key)
  if (group.sessions.length > visible) return true
  return !!sessionStore.getGroupMeta(group.key)?.hasMore
}

function isGroupLoadingMore(key: string): boolean {
  return sessionStore.isGroupLoadingMore(key)
}

async function showMore(key: string) {
  const groupSessions = sessionStore.sessions.filter(s => cloudGroupKey(s) === key)
  const visible = getVisibleCount(key)
  const meta = sessionStore.getGroupMeta(key)

  if (groupSessions.length <= visible && meta?.hasMore) {
    await sessionStore.loadMoreInGroup(key, EXPAND_STEP)
  }

  const loaded = sessionStore.sessions.filter(s => cloudGroupKey(s) === key).length
  expandedCounts.value.set(key, Math.min(loaded, visible + EXPAND_STEP))
  expandedCounts.value = new Map(expandedCounts.value)
}

function showLess(key: string) {
  expandedCounts.value.set(key, DEFAULT_VISIBLE)
  expandedCounts.value = new Map(expandedCounts.value)
}

async function refreshSessions() {
  expandedCounts.value = new Map()
  try {
    // 三个刷新相互独立：任一失败不应中断其余刷新，也不应让调用方出现 unhandledrejection
    const results = await Promise.allSettled([
      sessionStore.fetchSessions(),
      sessionStore.focusLoaded ? sessionStore.fetchFocusSessions(true) : Promise.resolve(),
      sessionStore.archivedLoaded ? sessionStore.fetchArchivedSessions(true) : Promise.resolve(),
    ])
    if (results.some((r) => r.status === 'rejected')) {
      ElMessage.error('刷新任务列表失败，请稍后重试')
    }
  } catch {
    ElMessage.error('刷新任务列表失败，请稍后重试')
  }
}

function toggleGroup(key: string) {
  toggleGroupCollapsed(key)
}

function hasPendingApproval(sessionId: string): boolean {
  const sid = String(sessionId)
  if ((sessionStore.sessionPendingApprovals?.get(sid) ?? 0) > 0) return true
  const session = sessionStore.getSessionEntity(sid)
  // 服务端聚合兜底：实时 Map 仅存内存，刷新后只有列表 VO 的 tree 字段能恢复橙点
  if ((session?.treePendingApprovalCount ?? session?.pendingApprovalCount ?? 0) > 0) return true
  return sessionStore.getSideTasks(sid).some(
    t => (sessionStore.sessionPendingApprovals?.get(String(t.id)) ?? 0) > 0
      || (t.pendingApprovalCount ?? 0) > 0
  )
}

function hasPendingQuestion(sessionId: string): boolean {
  const sid = String(sessionId)
  if ((sessionStore.sessionPendingQuestions?.get(sid)?.length ?? 0) > 0) return true
  const session = sessionStore.getSessionEntity(sid)
  if ((session?.treePendingQuestionCount ?? session?.pendingQuestionCount ?? 0) > 0) return true
  // 边路任务的提问事件 sessionId 是边路会话 id，实时记录在边路 id 名下，需聚合到父任务；
  // 边路 VO 计数与聚焦排序同源（sideTaskToFocusCandidate），覆盖断线期间提问、重连后经
  // side-tasks 端点刷新进缓存而实时表与父会话 tree 字段均滞后的场景
  return sessionStore.getSideTasks(sid).some(
    t => (sessionStore.sessionPendingQuestions?.get(String(t.id))?.length ?? 0) > 0
      || (t.pendingQuestionCount ?? 0) > 0
  )
}

// Drag handlers
function onGroupDragStart(e: DragEvent, index: number) {
  dragIndex.value = index
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', String(index))
}

function onGroupDragOver(e: DragEvent, index: number) {
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'move'
  dragOverIndex.value = index
}

function onGroupDragLeave() {
  dragOverIndex.value = null
}

function onGroupDrop(e: DragEvent, toIndex: number) {
  e.preventDefault()
  const fromIndex = dragIndex.value
  if (fromIndex !== null && fromIndex !== toIndex) {
    const keys = groupedSessions.value.map(g => g.key)
    onDragEnd(fromIndex, toIndex, keys)
  }
  dragIndex.value = null
  dragOverIndex.value = null
}

function onGroupDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}
</script>

<!-- 拆分子组件后样式须为非 scoped，否则无法作用到子组件 DOM（见 6b76ac8c 误删样式修复） -->
<style src="./task-index-panel.css"></style>
