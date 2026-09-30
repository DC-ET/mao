<template>
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
        <button class="group-add-btn" @click.stop="loadArchive(true)" title="刷新已归档" :disabled="archivedLoading">
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
        :data-session-id="session.id"
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
            @blur="onEditBlur()"
          />
          <span v-else class="session-title">{{ session.summary || session.title || '新任务' }}</span>
          <span class="focus-workspace-tag">{{ workspaceLabel(session) }}</span>
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
</template>

<script setup lang="ts">
import { Refresh, Loading, Delete, Check, Close, Folder, FolderOpened, EditPen, ArrowDown, ArrowRight, RefreshLeft } from '@element-plus/icons-vue'
import type { Session } from '../../stores/session'

defineProps<{
  archiveCollapsed: boolean
  archivedCount: number
  archivedLoading: boolean
  archivedSessions: Session[]
  activeSessionId: string | null
  confirmingDeleteId: string | null
  editingSessionId: string | null
  editingTitle: string
  showItemActions: boolean
  toggleArchive: () => void
  loadArchive: (force?: boolean) => void
  selectSession: (session: Session) => void
  openContextMenu: (e: MouseEvent, session: Session, zone: 'standard' | 'archived') => void
  onEditKeydown: (e: KeyboardEvent) => void
  onEditBlur: () => void
  workspaceLabel: (session: Session) => string
  formatElapsed: (session: Session) => string
  confirmDelete: (e: MouseEvent, sessionId: string) => void
  cancelDelete: (e?: MouseEvent) => void
  isDeleting: (id: string) => boolean
  doUnarchive: (id: string) => void
  isArchiving: (id: string) => boolean
  startEdit: (e: MouseEvent, session: Session) => void
  startDelete: (e: MouseEvent, sessionId: string) => void
}>()

const editingTitle = defineModel<string>('editingTitle', { default: '' })
</script>
