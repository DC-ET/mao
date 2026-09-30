<template>
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
      :data-session-id="session.id"
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
          @blur="onEditBlur()"
        />
        <div v-else class="focus-item-text">
          <div class="focus-title-row">
            <span class="session-title">{{ session.summary || session.title || '新任务' }}</span>
            <span v-if="session.running || session.treeRunning || hasActiveSideTask(session.id)" class="session-spinner"></span>
          </div>
          <div class="focus-subtitle-row">
            <span class="focus-workspace-tag">{{ workspaceLabel(session) }}</span>
            <span class="focus-status-label" :class="focusStatusClass(session)">{{ focusStatusLabel(session) }}</span>
          </div>
        </div>
      </div>
      <div v-if="showItemActions" class="session-item-actions">
        <template v-if="confirmingDeleteId === session.id">
          <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除" :disabled="isDeleting(session.id)">
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
          :data-session-id="session.id"
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
              @blur="onEditBlur()"
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
              <button class="action-btn action-confirm" @click="confirmDelete($event, session.id)" title="确认删除" :disabled="isDeleting(session.id)">
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

<script setup lang="ts">
import { Loading, Delete, Check, Close, EditPen, ArrowDown, ArrowRight, FolderChecked, Clock } from '@element-plus/icons-vue'
import type { Session } from '../../stores/session'

defineProps<{
  focusLoading: boolean
  focusError: boolean
  focusedSessions: Session[]
  visibleFocusMainSessions: Session[]
  focusMainSessions: Session[]
  historySessions: Session[]
  activeSessionId: string | null
  confirmingDeleteId: string | null
  editingSessionId: string | null
  editingTitle: string
  showItemActions: boolean
  FOCUS_DEFAULT_VISIBLE: number
  FOCUS_EXPAND_STEP: number
  loadFocus: () => void
  selectSession: (session: Session) => void
  openContextMenu: (e: MouseEvent, session: Session, zone: 'standard' | 'archived') => void
  effectivePhaseClass: (session: Session) => string
  onEditKeydown: (e: KeyboardEvent) => void
  onEditBlur: () => void
  hasActiveSideTask: (sessionId: string) => boolean
  workspaceLabel: (session: Session) => string
  focusStatusClass: (session: Session) => string
  focusStatusLabel: (session: Session) => string
  confirmDelete: (e: MouseEvent, sessionId: string) => void
  cancelDelete: (e?: MouseEvent) => void
  isDeleting: (id: string) => boolean
  startEdit: (e: MouseEvent, session: Session) => void
  startArchive: (e: MouseEvent, session: Session) => void
  startDelete: (e: MouseEvent, sessionId: string) => void
  formatElapsed: (session: Session) => string
}>()

const focusVisibleCount = defineModel<number>('focusVisibleCount', { default: 0 })
const historyCollapsed = defineModel<boolean>('historyCollapsed', { default: true })
const editingTitle = defineModel<string>('editingTitle', { default: '' })
</script>
