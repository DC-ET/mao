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
        <div v-if="loading" class="panel-loading">
          <el-icon class="is-loading"><Loading /></el-icon>
        </div>
        <div v-else-if="groupedSessions.length === 0" class="panel-empty">
          暂无任务
        </div>
        <template v-else>
          <div 
            v-for="(group, index) in groupedSessions" 
            :key="group.key" 
            class="session-group"
            :class="{ 
              'drag-over': dragOverIndex === index && dragIndex !== index,
              'dragging': dragIndex === index 
            }"
            draggable="true"
            @dragstart="onGroupDragStart($event, index)"
            @dragover="onGroupDragOver($event, index)"
            @dragleave="onGroupDragLeave"
            @drop="onGroupDrop($event, index)"
            @dragend="onGroupDragEnd"
          >
            <div class="group-header" @click="toggleGroup(group.key)">
              <div class="group-header-left">
                <el-icon :size="13" class="group-icon" :class="(group.key.startsWith('CLOUD:') || group.key.startsWith('FEISHU_')) ? 'icon-cloud' : 'icon-folder'">
                  <PartlyCloudy v-if="(group.key.startsWith('CLOUD:') || group.key.startsWith('FEISHU_')) && !isGroupCollapsed(group.key)" />
                  <Cloudy v-else-if="group.key.startsWith('CLOUD:') || group.key.startsWith('FEISHU_')" />
                  <FolderOpened v-else-if="!isGroupCollapsed(group.key)" />
                  <Folder v-else />
                </el-icon>
                <span class="group-label">{{ group.label }}</span>
                <el-icon :size="11" class="group-expand-arrow">
                  <ArrowDown v-if="!isGroupCollapsed(group.key)" />
                  <ArrowRight v-else />
                </el-icon>
              </div>
              <div v-if="showItemActions" class="group-header-actions">
                <button v-if="group.key.startsWith('LOCAL:')" class="group-add-btn" @click.stop="openGroupFolder(group)" title="在文件浏览器中打开">
                  <el-icon :size="12"><FolderOpened /></el-icon>
                </button>
                <button v-if="group.key.startsWith('LOCAL:')" class="group-add-btn group-add-btn--terminal" @click.stop="openTerminal(group)" title="在终端中打开">
                  <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </button>
                <button class="group-add-btn" @click.stop="onGroupNewTask(group)" title="在该分组新建任务">
                  <el-icon :size="12"><Plus /></el-icon>
                </button>
              </div>
            </div>
            <template v-if="!isGroupCollapsed(group.key)">
            <div
              v-for="session in group.sessions.slice(0, getVisibleCount(group.key))"
              :key="session.id"
              class="session-item"
              :class="{
                active: String(session.id) === String(activeSessionId),
                'confirming-delete': confirmingDeleteId === session.id,
                editing: editingSessionId === session.id
              }"
              @click="selectSession(session)"
              @contextmenu.prevent="openContextMenu($event, session, 'standard')"
            >
              <div class="session-item-main">
                <span
                  v-if="hasPendingApproval(session.id)"
                  class="session-approval-dot"
                  title="有待审批的命令"
                ></span>
                <span
                  v-else-if="hasPendingQuestion(session.id)"
                  class="session-question-dot"
                  title="有待回答的问题"
                ></span>
                <span v-else class="session-phase-dot" :class="effectivePhaseClass(session)"></span>
                <input
                  v-if="editingSessionId === session.id"
                  v-model="editingTitle"
                  class="session-title-input"
                  @keydown="onEditKeydown"
                  @click.stop
                  @blur="confirmEdit()"
                />
                <span v-else class="session-title">{{ session.summary || session.title || '新任务' }}</span>
              </div>
              <div class="session-item-meta">
                <span v-if="session.running || hasActiveSideTask(session.id)" class="session-spinner"></span>
                <span v-if="(session.unread || hasUnreadSideTask(session.id)) && String(session.id) !== String(activeSessionId)" class="session-unread-dot"></span>
                <span class="session-elapsed">{{ formatElapsed(session) }}</span>
              </div>
              <div v-if="showItemActions" class="session-item-actions">
                <template v-if="confirmingDeleteId === session.id">
                  <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelDelete($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else-if="editingSessionId === session.id">
                  <button class="action-btn action-confirm" @click="confirmEdit($event)" title="确认">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelEdit($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else>
                  <button class="action-btn action-edit" @click="startEdit($event, session)" title="重命名">
                    <el-icon :size="13"><EditPen /></el-icon>
                  </button>
                  <button class="action-btn action-delete" @click="startDelete($event, session.id)" title="删除任务">
                    <el-icon :size="13"><Delete /></el-icon>
                  </button>
                </template>
              </div>
            </div>
            <div
              v-if="canExpandGroup(group)"
              class="group-toggle"
              :class="{ disabled: isGroupLoadingMore(group.key) }"
              @click="!isGroupLoadingMore(group.key) && showMore(group.key)"
            >
              {{ isGroupLoadingMore(group.key) ? '加载中…' : '展开更多' }}
            </div>
            <div
              v-else-if="getVisibleCount(group.key) > DEFAULT_VISIBLE"
              class="group-toggle"
              @click="showLess(group.key)"
            >
              收起
            </div>
            </template>
          </div>
        </template>
        </template>

        <!-- 聚焦模式：全量平铺 + 优先级排序 -->
        <template v-else>
          <div v-if="focusLoading && focusedSessions.length === 0" class="panel-loading">
            <el-icon class="is-loading"><Loading /></el-icon>
          </div>
          <div v-else-if="focusError" class="panel-error">
            <span>聚焦列表加载失败</span>
            <button class="retry-btn" @click="loadFocus()">重试</button>
          </div>
          <div v-else-if="focusedSessions.length === 0" class="panel-empty">
            暂无任务
          </div>
          <template v-else>
            <div
              v-for="session in visibleFocusMainSessions"
              :key="session.id"
              class="session-item focus-item"
              :class="{
                active: String(session.id) === String(activeSessionId),
                'confirming-delete': confirmingDeleteId === session.id,
                editing: editingSessionId === session.id
              }"
              @click="selectSession(session)"
              @contextmenu.prevent="openContextMenu($event, session, 'standard')"
            >
              <div class="session-item-main focus-item-content">
                <span class="session-phase-dot" :class="effectivePhaseClass(session)"></span>
                <input
                  v-if="editingSessionId === session.id"
                  v-model="editingTitle"
                  class="session-title-input"
                  @keydown="onEditKeydown"
                  @click.stop
                  @blur="confirmEdit()"
                />
                <div v-else class="focus-item-text">
                  <div class="focus-title-row">
                    <span class="session-title">{{ session.summary || session.title || '新任务' }}</span>
                    <span v-if="session.running || hasActiveSideTask(session.id)" class="session-spinner"></span>
                  </div>
                  <div class="focus-subtitle-row">
                    <span class="focus-workspace-tag">{{ workspaceLabel(session) }}</span>
                    <span class="focus-status-label" :class="focusStatusClass(session)">{{ focusStatusLabel(session) }}</span>
                  </div>
                </div>
              </div>
              <div v-if="showItemActions" class="session-item-actions">
                <template v-if="confirmingDeleteId === session.id">
                  <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelDelete($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else>
                  <button class="action-btn action-edit" @click="startEdit($event, session)" title="重命名">
                    <el-icon :size="13"><EditPen /></el-icon>
                  </button>
                  <button class="action-btn action-archive" @click="startArchive($event, session)" title="归档">
                    <el-icon :size="13"><FolderChecked /></el-icon>
                  </button>
                  <button class="action-btn action-delete" @click="startDelete($event, session.id)" title="删除任务">
                    <el-icon :size="13"><Delete /></el-icon>
                  </button>
                </template>
              </div>
            </div>
            <div
              v-if="focusMainSessions.length > FOCUS_DEFAULT_VISIBLE"
              class="group-toggle"
              @click="focusVisibleCount += FOCUS_EXPAND_STEP"
            >
              展开更多
            </div>
            <!-- 历史折叠区：已完成且超过 3 天无更新的任务 -->
            <div v-if="historySessions.length > 0" class="focus-history">
              <div class="group-header" @click="historyCollapsed = !historyCollapsed">
                <div class="group-header-left">
                  <el-icon :size="13" class="group-icon"><Clock /></el-icon>
                  <span class="group-label">历史（{{ historySessions.length }}）</span>
                  <el-icon :size="11" class="group-expand-arrow">
                    <ArrowDown v-if="!historyCollapsed" />
                    <ArrowRight v-else />
                  </el-icon>
                </div>
              </div>
              <template v-if="!historyCollapsed">
                <div
                  v-for="session in historySessions"
                  :key="session.id"
                  class="session-item focus-item"
                  :class="{
                    active: String(session.id) === String(activeSessionId),
                    'confirming-delete': confirmingDeleteId === session.id,
                    editing: editingSessionId === session.id
                  }"
                  @click="selectSession(session)"
                  @contextmenu.prevent="openContextMenu($event, session, 'standard')"
                >
                  <div class="session-item-main">
                    <input
                      v-if="editingSessionId === session.id"
                      v-model="editingTitle"
                      class="session-title-input"
                      @keydown="onEditKeydown"
                      @click.stop
                      @blur="confirmEdit()"
                    />
                    <template v-else>
                      <span class="session-title">{{ session.summary || session.title || '新任务' }}</span>
                      <span class="focus-workspace-tag">{{ workspaceLabel(session) }}</span>
                    </template>
                  </div>
                  <div class="session-item-meta">
                    <span class="session-elapsed">{{ formatElapsed(session) }}</span>
                  </div>
                  <div v-if="showItemActions" class="session-item-actions">
                    <template v-if="confirmingDeleteId === session.id">
                      <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除">
                        <el-icon :size="13"><Check /></el-icon>
                      </button>
                      <button class="action-btn action-cancel" @click="cancelDelete($event)" title="取消">
                        <el-icon :size="13"><Close /></el-icon>
                      </button>
                    </template>
                    <template v-else>
                      <button class="action-btn action-edit" @click="startEdit($event, session)" title="重命名">
                        <el-icon :size="13"><EditPen /></el-icon>
                      </button>
                      <button class="action-btn action-archive" @click="startArchive($event, session)" title="归档">
                        <el-icon :size="13"><FolderChecked /></el-icon>
                      </button>
                      <button class="action-btn action-delete" @click="startDelete($event, session.id)" title="删除任务">
                        <el-icon :size="13"><Delete /></el-icon>
                      </button>
                    </template>
                  </div>
                </div>
              </template>
            </div>
          </template>
        </template>

        <!-- 已归档区（两种模式下都显示在底部） -->
        <div class="archive-section">
          <div class="group-header" @click="toggleArchive">
            <div class="group-header-left">
              <el-icon :size="13" class="group-icon icon-archive"><FolderOpened v-if="!archiveCollapsed" /><Folder v-else /></el-icon>
              <span class="group-label">已归档</span>
              <el-icon :size="11" class="group-expand-arrow">
                <ArrowDown v-if="!archiveCollapsed" />
                <ArrowRight v-else />
              </el-icon>
            </div>
            <div class="group-header-actions">
              <span v-if="archivedCount > 0" class="archive-count">{{ archivedCount }}</span>
              <button class="group-add-btn" @click.stop="loadArchive(true)" title="刷新已归档">
                <el-icon :size="12"><Refresh /></el-icon>
              </button>
            </div>
          </div>
          <template v-if="!archiveCollapsed">
            <div v-if="archivedLoading && archivedSessions.length === 0" class="panel-loading">
              <el-icon class="is-loading"><Loading /></el-icon>
            </div>
            <div v-else-if="archivedSessions.length === 0" class="side-task-empty">
              暂无已归档任务
            </div>
            <div
              v-for="session in archivedSessions"
              :key="session.id"
              class="session-item archive-item"
              :class="{
                active: String(session.id) === String(activeSessionId),
                'confirming-delete': confirmingDeleteId === session.id,
                editing: editingSessionId === session.id
              }"
              @click="selectSession(session)"
              @contextmenu.prevent="openContextMenu($event, session, 'archived')"
            >
              <div class="session-item-main">
                <input
                  v-if="editingSessionId === session.id"
                  v-model="editingTitle"
                  class="session-title-input"
                  @keydown="onEditKeydown"
                  @click.stop
                  @blur="confirmEdit()"
                />
                <span v-else class="session-title">{{ session.summary || session.title || '新任务' }}</span>
                <span class="focus-workspace-tag">{{ workspaceLabel(session) }}</span>
              </div>
              <div class="session-item-meta">
                <span class="session-elapsed">{{ formatElapsed(session) }}</span>
              </div>
              <div v-if="showItemActions" class="session-item-actions">
                <template v-if="confirmingDeleteId === session.id">
                  <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除">
                    <el-icon :size="13"><Check /></el-icon>
                  </button>
                  <button class="action-btn action-cancel" @click="cancelDelete($event)" title="取消">
                    <el-icon :size="13"><Close /></el-icon>
                  </button>
                </template>
                <template v-else>
                  <button class="action-btn action-restore" @click="doUnarchive(session.id)" title="恢复" :disabled="isArchiving(session.id)">
                    <el-icon :size="13"><RefreshLeft /></el-icon>
                  </button>
                  <button class="action-btn action-edit" @click="startEdit($event, session)" title="重命名">
                    <el-icon :size="13"><EditPen /></el-icon>
                  </button>
                  <button class="action-btn action-delete" @click="startDelete($event, session.id)" title="删除任务">
                    <el-icon :size="13"><Delete /></el-icon>
                  </button>
                </template>
              </div>
            </div>
          </template>
        </div>
      </div>
    </template>
    <div
      v-if="!collapsed"
      class="resize-handle"
      @mousedown="onResizeStart"
      @touchstart.prevent="onResizeStart"
    ></div>

    <!-- 右键菜单（Teleport 到 body，桌面右键 / 移动端长按） -->
    <Teleport to="body">
      <div
        v-if="contextMenu.visible"
        class="task-context-menu"
        :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
        @click.stop
      >
        <template v-if="contextMenu.zone === 'archived'">
          <div class="context-menu-item" @click="menuUnarchive">恢复</div>
          <div class="context-menu-item" @click="menuEditTitle">编辑标题</div>
          <div class="context-menu-item danger" @click="menuDelete">删除</div>
        </template>
        <template v-else>
          <div class="context-menu-item" @click="menuEditTitle">编辑标题</div>
          <div class="context-menu-item" @click="menuArchive">归档</div>
          <div class="context-menu-item danger" @click="menuDelete">删除</div>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { Refresh, Loading, Plus, Delete, Check, Close, Cloudy, PartlyCloudy, Folder, FolderOpened, EditPen, ArrowDown, ArrowRight, FolderChecked, RefreshLeft, Clock, Bell, BellFilled } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'
import { useTerminal } from '../../composables/useTerminal'
import { useTaskPanelPrefs } from '../../composables/useTaskPanelPrefs'
import { cloudGroupKey, formatCloudGroupLabel, isSharedCloudProject, FEISHU_PLACEHOLDER_TITLE } from '../../utils/cloud-project'
import { sessionToFocusCandidate, sortByFocusPriority, isHistoryEligible } from '../../utils/focusSort'

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
const { sortGroups, onDragEnd, loadPrefs, isGroupCollapsed, toggleGroupCollapsed } = useTaskPanelPrefs()

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

/** 聚焦模式：全量 ACTIVE 主会话按优先级排序（服务端 tree* 信号 + 实时信号）。 */
const focusedSessions = computed<Session[]>(() =>
  sortByFocusPriority(sessionStore.focusedSessions.map(sessionToFocusCandidate))
    .map(c => sessionStore.focusedSessions.find(s => String(s.id) === String(c.id)))
    .filter((s): s is Session => !!s)
)

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
  const menuWidth = 140
  const menuHeight = 120
  const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8)
  const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8)
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
  if (id) confirmingDeleteId.value = id
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

function workspaceLabel(session: Session): string {
  const key = cloudGroupKey(session)
  return formatGroupLabel(key)
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
  if (session.phase === 'RUNNING') return `运行中 ${formatDurationSince(session.startedAt || session.updatedAt || session.createdAt)}`
  if (session.phase === 'RESUMING') return '恢复中'
  if (session.phase === 'WAITING_APPROVAL') return '待审批'
  if (session.phase === 'CANCELLING') return '取消中'
  if (runningSide) return `运行中 ${formatDurationSince(runningSide.startedAt || runningSide.updatedAt || runningSide.createdAt)}`
  if (session.treeRunning) return `运行中 ${formatDurationSince(session.updatedAt || session.createdAt)}`
  switch (session.phase) {
    case 'COMPLETED': return `${formatRelativeSince(session.updatedAt || session.createdAt)}前完成`
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
}
function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && contextMenu.visible) closeContextMenu()
}
onMounted(() => {
  document.addEventListener('click', onGlobalClick)
  document.addEventListener('keydown', onGlobalKeydown)
})
onUnmounted(() => {
  document.removeEventListener('click', onGlobalClick)
  document.removeEventListener('keydown', onGlobalKeydown)
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
  const workspace = group.key.startsWith('LOCAL:') ? group.key.substring(6) : ''
  if (workspace && window.electronAPI?.openFolder) {
    window.electronAPI.openFolder(workspace)
  }
}

function openTerminal(group: { key: string }) {
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
    if (a.startsWith('CLOUD:') && !b.startsWith('CLOUD:')) return -1
    if (!a.startsWith('CLOUD:') && b.startsWith('CLOUD:')) return 1
    return a.localeCompare(b)
  })

  const result = entries.map(([key, sessions]) => ({
    key,
    label: formatGroupLabel(key, sessions[0]),
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

function formatGroupLabel(key: string, session?: Session): string {
  if (key.startsWith('FEISHU_PRIVATE:')) return session?.agentName || '未知 Agent'
  if (key.startsWith('FEISHU_GROUP:')) {
    const title = session?.title && session.title !== FEISHU_PLACEHOLDER_TITLE ? session.title : undefined
    return `${session?.agentName || '未知 Agent'}:${title ?? '飞书群聊'}`
  }
  if (key.startsWith('CLOUD:')) return formatCloudGroupLabel(key, session)
  if (key.startsWith('LOCAL:')) {
    const ws = key.substring(6)
    if (ws === '未设置') return '未设置'
    const parts = ws.split('/').filter(Boolean)
    return parts[parts.length - 1] || ws
  }
  return key
}

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
  return formatRelativeSince(session.createdAt)
}

function formatDurationSince(time?: string) {
  return formatTimeDiff(time)
}

function formatRelativeSince(time?: string) {
  return formatTimeDiff(time)
}

function formatTimeDiff(time?: string) {
  if (!time) return ''
  const now = Date.now()
  const t = new Date(time).getTime()
  const diffMs = now - t
  if (diffMs < 0) return ''

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}月`
  const years = Math.floor(months / 12)
  return `${years}年`
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
  const wasActive = sessionStore.activeSessionId === sessionId
  await sessionStore.deleteSession(sessionId)
  confirmingDeleteId.value = null
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

async function confirmEdit(e?: MouseEvent) {
  e?.stopPropagation()
  const id = editingSessionId.value
  const title = editingTitle.value.trim()
  if (!id || !title) {
    cancelEdit()
    return
  }
  await sessionStore.renameSession(id, title)
  editingSessionId.value = null
  editingTitle.value = ''
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
  await sessionStore.fetchSessions()
  // 聚焦数据已加载过 → 同步静默刷新（保持聚焦列表实时）
  if (sessionStore.focusLoaded) {
    await sessionStore.fetchFocusSessions(true)
  }
  // 已归档区已加载过 → 同步静默刷新
  if (sessionStore.archivedLoaded) {
    await sessionStore.fetchArchivedSessions(true)
  }
}

function toggleGroup(key: string) {
  toggleGroupCollapsed(key)
}

function hasPendingApproval(sessionId: string): boolean {
  const sid = String(sessionId)
  if ((sessionStore.sessionPendingApprovals?.get(sid) ?? 0) > 0) return true
  return sessionStore.getSideTasks(sid).some(
    t => (sessionStore.sessionPendingApprovals?.get(String(t.id)) ?? 0) > 0
  )
}

function hasPendingQuestion(sessionId: string): boolean {
  return (sessionStore.sessionPendingQuestions?.get(String(sessionId))?.length ?? 0) > 0
}

// Drag handlers
function onGroupDragStart(e: DragEvent, index: number) {
  dragIndex.value = index
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', String(index))
  // 添加拖拽时的半透明效果
  const target = e.target as HTMLElement
  target.classList.add('dragging')
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

<style scoped>
.task-index-panel {
  position: relative;
  width: var(--aw-session-panel-width);
  flex-shrink: 0;
  background: var(--aw-canvas-parchment);
  backdrop-filter: saturate(180%) blur(20px);
  border-right: 1px solid var(--aw-divider-soft);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.task-index-panel.collapsed {
  display: none;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  flex-shrink: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.panel-title {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.refresh-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.refresh-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.panel-content {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.panel-loading, .panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 80px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.group-header {
  position: relative;
  font-size: var(--aw-text-micro);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 4px 4px;
  display: flex;
  align-items: center;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}

.group-header:hover {
  color: var(--aw-ink);
}

.group-header-left {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.group-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-expand-arrow {
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.15s;
  color: var(--aw-ink-muted-48);
}

.group-header:hover .group-expand-arrow {
  opacity: 0.7;
}

.task-index-panel:not(.actions-hidden) .group-header:hover .group-expand-arrow {
  opacity: 0;
}

.group-header-actions {
  position: absolute;
  right: 4px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px 2px 12px;
  border-radius: var(--aw-radius-xs);
  background: var(--aw-canvas-parchment);
  z-index: 1;
  opacity: 0;
  transition: opacity 0.15s;
  pointer-events: none;
}

.group-header-actions::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 12px;
  background: linear-gradient(to right, transparent, var(--aw-canvas-parchment));
  pointer-events: none;
}

.group-header:hover .group-header-actions {
  opacity: 1;
  pointer-events: auto;
}

.group-add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.group-add-btn--terminal {
  width: 24px;
  height: 24px;
}

.group-add-btn:hover {
  background: var(--aw-surface-pearl);
  color: var(--aw-primary);
}

.session-group {
  transition: transform 0.15s, opacity 0.15s;
}

.session-group.dragging {
  opacity: 0.5;
  transform: scale(0.98);
}

.session-group.drag-over {
  border-top: 2px solid var(--aw-primary);
  margin-top: -2px;
}

.session-group.drag-over::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--aw-primary);
  z-index: 1;
}

.group-icon {
  flex-shrink: 0;
}

.group-icon.icon-cloud {
  color: #60a5fa;
}

.group-icon.icon-folder {
  color: #f59e0b;
}

.group-toggle {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  padding: 4px 10px 6px 24px;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s;
}

.group-toggle.disabled {
  cursor: default;
  opacity: 0.6;
}

.group-toggle:hover {
  color: var(--aw-ink);
}

.group-toggle.disabled:hover {
  color: var(--aw-ink-muted-48);
}

.session-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  transition: background 0.15s;
  gap: 8px;
}

.session-item:hover {
  background: rgba(0, 0, 0, 0.04);
}

.session-item.active {
  background: var(--aw-primary-lighter);
}

.session-item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.session-phase-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.session-phase-dot.running { background: var(--aw-primary); }
.session-phase-dot.waiting { background: #b37400; }
.session-phase-dot.completed { background: var(--aw-success); }
.session-phase-dot.failed { background: var(--aw-danger); }
.session-phase-dot.idle { background: var(--aw-hairline); }

.session-unread-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #00d4aa;
  flex-shrink: 0;
  margin-right: 2px;
}

.session-approval-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
  animation: pulse-approval 1.5s ease-in-out infinite;
}

@keyframes pulse-approval {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.session-question-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
  animation: pulse-question 1.5s ease-in-out infinite;
}

@keyframes pulse-question {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.session-title {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.224px;
}

.session-item-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-item-meta,
.session-item.confirming-delete .session-item-meta,
.session-item.editing .session-item-meta {
  opacity: 0;
}

.task-index-panel.actions-hidden .session-item:hover .session-item-meta {
  opacity: 1;
}

.session-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--aw-hairline);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.session-elapsed {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.1px;
}

.session-item-actions {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px 4px;
  border-radius: var(--aw-radius-xs);
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .session-item-actions,
.session-item.confirming-delete .session-item-actions,
.session-item.editing .session-item-actions {
  opacity: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
  color: var(--aw-ink-muted-48);
}

.action-delete:hover {
  background: #fee2e2;
  color: var(--aw-danger);
}

.action-edit:hover {
  background: #f3f4f6;
  color: var(--aw-primary);
}

.session-title-input {
  flex: 1;
  min-width: 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  letter-spacing: -0.224px;
  background: var(--aw-surface-pearl);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 1px 6px;
  outline: none;
}

.session-item.editing {
  background: var(--aw-surface-pearl);
}

.action-confirm {
  background: #fee2e2;
  color: var(--aw-danger);
}

.action-confirm:hover {
  background: #fecaca;
}

.action-cancel:hover {
  background: #f3f4f6;
  color: var(--aw-ink);
}

.session-item.confirming-delete {
  background: rgba(220, 53, 69, 0.04);
}

/* Resize handle */
.resize-handle {
  position: absolute;
  top: 0;
  right: -8px;
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
  background: rgba(0, 102, 204, 0.06);
}

.resize-handle:hover::before,
.resize-handle:active::before {
  background: var(--aw-primary);
  height: 48px;
}

/* Wider touch target and visible grip on touch devices */
@media (max-width: 768px), (pointer: coarse) {
  .resize-handle {
    width: 44px;
    right: -22px;
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

/* Scrollbar — hidden by default, visible on hover */
.panel-content {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
  transition: scrollbar-color 0.3s;
}

.panel-content:hover {
  scrollbar-color: var(--aw-hairline) transparent;
}

.panel-content::-webkit-scrollbar {
  width: 4px;
}

.panel-content::-webkit-scrollbar-track {
  background: transparent;
}

.panel-content::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 2px;
  transition: background 0.3s;
}

.panel-content:hover::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
}

/* Dark mode */
[data-theme="dark"] .task-index-panel {
  background: var(--aw-canvas-parchment);
  border-right-color: var(--aw-hairline);
}

[data-theme="dark"] .session-item:hover {
  background: rgba(255, 255, 255, 0.04);
}

[data-theme="dark"] .session-item.active {
  background: var(--aw-primary-lighter);
}

[data-theme="dark"] .action-btn {
  background: #1a1a2e;
}

[data-theme="dark"] .group-add-btn {
  background: #1a1a2e;
}

[data-theme="dark"] .group-header-actions {
  background: #1a1a2e;
}

[data-theme="dark"] .group-header-actions::before {
  background: linear-gradient(to right, transparent, #1a1a2e);
}

[data-theme="dark"] .group-add-btn:hover {
  background: #27272a;
  color: var(--aw-primary);
}

[data-theme="dark"] .action-delete:hover {
  background: #3b1520;
  color: #f85149;
}

[data-theme="dark"] .action-edit:hover {
  background: #27272a;
  color: var(--aw-primary);
}

[data-theme="dark"] .session-title-input {
  background: rgba(255, 255, 255, 0.06);
  border-color: var(--aw-primary);
}

[data-theme="dark"] .session-item.editing {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .action-confirm {
  background: #3b1520;
  color: #f85149;
}

[data-theme="dark"] .action-confirm:hover {
  background: #5c1d2e;
}

[data-theme="dark"] .action-cancel:hover {
  background: #27272a;
  color: var(--aw-ink);
}

[data-theme="dark"] .session-item.confirming-delete {
  background: rgba(248, 81, 73, 0.06);
}

[data-theme="dark"] .group-icon.icon-cloud {
  color: #93c5fd;
}

[data-theme="dark"] .group-icon.icon-folder {
  color: #fbbf24;
}

[data-theme="dark"] .session-group.drag-over::before {
  background: var(--aw-primary);
}

/* --- 模式切换 --- */
.mode-toggle-btn {
  margin-right: 2px;
}

/* 选中（聚焦模式）时图标高亮为选中蓝；hover 保持同色避免闪烁 */
.mode-toggle-btn.active,
.mode-toggle-btn.active:hover {
  color: var(--aw-primary);
}

/* --- 聚焦模式 --- */
.focus-item {
  align-items: flex-start;
  padding-block: 7px;
}

.focus-item .focus-item-content {
  align-items: flex-start;
  gap: 8px;
}

.focus-item .session-phase-dot {
  margin-top: 7px;
}

.focus-item-text {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.focus-title-row,
.focus-subtitle-row {
  display: flex;
  align-items: center;
  min-width: 0;
}

.focus-title-row {
  gap: 6px;
}

.focus-title-row .session-title {
  flex: 1;
  min-width: 0;
}

.focus-subtitle-row {
  gap: 7px;
  padding-right: 4px;
}

.focus-workspace-tag {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  background: rgba(0, 0, 0, 0.05);
  border-radius: var(--aw-radius-xs);
  padding: 1px 5px;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.1px;
}

.focus-status-label {
  flex-shrink: 0;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
  letter-spacing: -0.1px;
}

.focus-status-label.status-waiting { color: #b37400; }
.focus-status-label.status-failed { color: var(--aw-danger); }
.focus-status-label.status-running { color: var(--aw-primary); }
.focus-status-label.status-completed { color: var(--aw-ink-muted-48); }

.focus-history {
  margin-top: 4px;
  border-top: 1px dashed var(--aw-divider-soft);
  padding-top: 2px;
}

/* --- 已归档区 --- */
.archive-section {
  margin-top: 4px;
  border-top: 1px dashed var(--aw-divider-soft);
  padding-top: 2px;
}

.archive-count {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  margin-right: 6px;
}

.group-header-left .icon-archive {
  color: var(--aw-ink-muted-48);
}

.action-archive:hover {
  background: #f3f4f6;
  color: var(--aw-primary);
}

.action-restore:hover {
  background: #dcfce7;
  color: var(--aw-success);
}

[data-theme="dark"] .action-archive:hover {
  background: #27272a;
  color: var(--aw-primary);
}

[data-theme="dark"] .action-restore:hover {
  background: #12331f;
  color: #4ade80;
}

[data-theme="dark"] .focus-workspace-tag {
  background: rgba(255, 255, 255, 0.08);
}

/* --- 聚焦加载失败 --- */
.panel-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
}

.retry-btn {
  border: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  color: var(--aw-ink);
  border-radius: var(--aw-radius-xs);
  padding: 4px 14px;
  font-size: var(--aw-text-caption);
  cursor: pointer;
}

.retry-btn:hover {
  color: var(--aw-primary);
  border-color: var(--aw-primary);
}

.side-task-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 8px 0;
}
</style>

<style>
/* 右键菜单（Teleport 到 body，scoped 外） */
.task-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 140px;
  padding: 4px 0;
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-divider-soft, #e0e0e0);
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  user-select: none;
}

.context-menu-item {
  padding: 7px 16px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink, #1a1a1a);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.context-menu-item:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-primary, #0066cc);
}

.context-menu-item.danger {
  color: var(--aw-danger, #d92d20);
}

.context-menu-item.danger:hover {
  background: #fee2e2;
}

[data-theme="dark"] .task-context-menu {
  background: #2a2a2a;
  border-color: var(--aw-hairline, #3a3a3a);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .context-menu-item {
  color: var(--aw-ink, #e0e0e0);
}

[data-theme="dark"] .context-menu-item:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--aw-primary);
}

[data-theme="dark"] .context-menu-item.danger:hover {
  background: #3b1520;
  color: #f85149;
}
</style>
