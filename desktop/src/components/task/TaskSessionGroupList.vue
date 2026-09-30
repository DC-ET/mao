<template>
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
      <div class="group-header" @click="toggleGroup(group.key)" @contextmenu.prevent="openGroupContextMenu($event, group.key)">
        <div class="group-header-left">
          <span class="group-icon" :class="`icon-${groupIconKind(group.key, group.sessions)}`">
            <img
              v-if="groupIconKind(group.key, group.sessions) === 'feishu'"
              class="brand-icon"
              :src="feishuLogo"
              width="13"
              height="13"
              alt="飞书"
              draggable="false"
            />
            <img
              v-else-if="groupIconKind(group.key, group.sessions) === 'weixin'"
              class="brand-icon"
              :src="weixinLogo"
              width="13"
              height="13"
              alt="微信"
              draggable="false"
            />
            <el-icon v-else-if="groupIconKind(group.key, group.sessions) === 'dingtalk'" :size="13">
              <ChatDotRound />
            </el-icon>
            <el-icon v-else-if="groupIconKind(group.key, group.sessions) === 'embed'" :size="13">
              <Monitor />
            </el-icon>
            <el-icon v-else :size="13">
              <PartlyCloudy v-if="groupIconKind(group.key, group.sessions) === 'cloud' && !isGroupCollapsed(group.key)" />
              <Cloudy v-else-if="groupIconKind(group.key, group.sessions) === 'cloud'" />
              <FolderOpened v-else-if="!isGroupCollapsed(group.key)" />
              <Folder v-else />
            </el-icon>
          </span>
          <input
            v-if="renamingGroupKey === group.key"
            v-model="renamingValue"
            class="session-title-input group-rename-input"
            :ref="(el) => setGroupRenameInput(group.key, el)"
            @keydown="onGroupRenameKeydown"
            @click.stop
            @blur="onGroupRenameBlur"
          />
          <span
            v-else
            class="group-label"
            :title="groupAliasTooltip(group.key)"
          >{{ group.label }}</span>
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
        :data-session-id="session.id"
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
            @blur="onEditBlur()"
          />
          <span v-else class="session-title">{{ session.summary || session.title || '新任务' }}</span>
        </div>
        <div class="session-item-meta">
          <span v-if="session.running || session.treeRunning || hasActiveSideTask(session.id)" class="session-spinner"></span>
          <span v-if="(session.unread || hasUnreadSideTask(session.id)) && String(session.id) !== String(activeSessionId)" class="session-unread-dot"></span>
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

<script setup lang="ts">
import { Loading, Plus, Delete, Check, Close, Cloudy, PartlyCloudy, Folder, FolderOpened, EditPen, ArrowDown, ArrowRight, ChatDotRound, Monitor } from '@element-plus/icons-vue'
import type { Session } from '../../stores/session'
import { groupIconKind } from '../../utils/cloud-project'
import feishuLogo from '../../assets/feishu-logo.svg'
import weixinLogo from '../../assets/weixin-logo.png'

defineProps<{
  loading: boolean
  groupedSessions: { key: string; label: string; sessions: Session[] }[]
  dragOverIndex: number | null
  dragIndex: number | null
  renamingGroupKey: string | null
  renamingValue: string
  showItemActions: boolean
  activeSessionId: string | null
  confirmingDeleteId: string | null
  editingSessionId: string | null
  editingTitle: string
  DEFAULT_VISIBLE: number
  toggleGroup: (key: string) => void
  openGroupContextMenu: (e: MouseEvent, key: string) => void
  setGroupRenameInput: (key: string, el: unknown) => void
  onGroupRenameKeydown: (e: KeyboardEvent) => void
  onGroupRenameBlur: () => void
  groupAliasTooltip: (key: string) => string
  isGroupCollapsed: (key: string) => boolean
  openGroupFolder: (group: { key: string }) => void
  openTerminal: (group: { key: string }) => void
  onGroupNewTask: (group: { sessions: Session[] }) => void
  getVisibleCount: (key: string) => number
  selectSession: (session: Session) => void
  openContextMenu: (e: MouseEvent, session: Session, zone: 'standard' | 'archived') => void
  hasPendingApproval: (sessionId: string) => boolean
  hasPendingQuestion: (sessionId: string) => boolean
  effectivePhaseClass: (session: Session) => string
  onEditKeydown: (e: KeyboardEvent) => void
  onEditBlur: () => void
  hasActiveSideTask: (sessionId: string) => boolean
  hasUnreadSideTask: (sessionId: string) => boolean
  formatElapsed: (session: Session) => string
  confirmDelete: (e: MouseEvent, sessionId: string) => void
  cancelDelete: (e?: MouseEvent) => void
  isDeleting: (id: string) => boolean
  confirmEdit: (e?: MouseEvent) => void
  cancelEdit: (e?: MouseEvent) => void
  startEdit: (e: MouseEvent, session: Session) => void
  startDelete: (e: MouseEvent, sessionId: string) => void
  canExpandGroup: (group: { key: string; sessions: Session[] }) => boolean
  isGroupLoadingMore: (key: string) => boolean
  showMore: (key: string) => void
  showLess: (key: string) => void
  onGroupDragStart: (e: DragEvent, index: number) => void
  onGroupDragOver: (e: DragEvent, index: number) => void
  onGroupDragLeave: () => void
  onGroupDrop: (e: DragEvent, toIndex: number) => void
  onGroupDragEnd: () => void
}>()

const renamingValue = defineModel<string>('renamingValue', { default: '' })
const editingTitle = defineModel<string>('editingTitle', { default: '' })
</script>
