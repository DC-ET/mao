<template>
  <div class="chat-input-card">
    <!-- New task config bar -->
    <div v-if="isNewTask" class="new-task-config-bar">
      <AgentSelector
        :selected-agent-id="selectedAgentId"
        @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
      />
      <div class="config-row">
        <el-radio-group :model-value="executionMode" size="small" @change="handleModeChange">
          <el-radio-button value="CLOUD">
            <el-icon :size="12"><Cloudy /></el-icon> 云端模式
          </el-radio-button>
          <el-radio-button value="LOCAL">
            <el-icon :size="12"><Monitor /></el-icon> 本地模式
          </el-radio-button>
        </el-radio-group>
        <div
          v-if="executionMode === 'LOCAL'"
          class="workspace-selector"
          :class="{ 'has-workspace': !!workspace }"
          @click="selectWorkspace"
        >
          <el-icon :size="13">
            <WarningFilled v-if="!workspace" />
            <FolderOpened v-else />
          </el-icon>
          <span>{{ workspace ? dirName : '选择工作目录' }}</span>
        </div>
      </div>
      <div class="config-divider"></div>
    </div>

    <!-- Textarea area -->
    <div class="textarea-area" :class="{ 'new-task-textarea': isNewTask }">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="chat-textarea"
        :placeholder="loading ? 'Agent 执行中，发送的消息将进入队列...' : placeholder"
        rows="1"
        @input="autoResize"
        @keydown.enter.ctrl.prevent="handleSendKey"
        @keydown.enter.meta.prevent="handleSendKey"
        @paste="handlePaste"
      />
      <div class="resize-handle" title="拖拽调整大小">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M13 1L1 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M13 5L5 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          <path d="M13 9L9 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
        </svg>
      </div>
    </div>

    <!-- Pending files -->
    <div v-if="pendingFiles.length > 0" class="pending-files">
      <div v-for="(file, idx) in pendingFiles" :key="idx" class="pending-file">
        <img v-if="filePreviewUrls[idx]" :src="filePreviewUrls[idx]" class="file-preview-img" />
        <el-icon v-else><Document /></el-icon>
        <span class="file-name">{{ file.name }}</span>
        <el-icon class="remove-file" @click="removeFile(idx)"><Close /></el-icon>
      </div>
    </div>

    <!-- Bottom toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="add-btn" title="上传图片">
          <input type="file" multiple accept="image/*" @change="handleFileSelect" style="display: none" />
          <el-icon :size="16"><Plus /></el-icon>
        </label>
        <div class="workspace-indicator" :class="{ 'has-workspace': !!workspace, 'cloud-mode': executionMode === 'CLOUD' }" @click="executionMode !== 'CLOUD' && openWorkspace()">
          <template v-if="executionMode === 'CLOUD'">
            <el-icon :size="14"><Cloudy /></el-icon>
            <span>云端工作区</span>
          </template>
          <template v-else>
            <span class="mode-label-inline">本地</span>
            <el-icon :size="14">
              <WarningFilled v-if="!workspace" />
              <FolderOpened v-else />
            </el-icon>
            <span>{{ dirName || 'No workspace' }}</span>
          </template>
        </div>
        <PermissionLevelSwitcher
          v-if="executionMode === 'LOCAL'"
          :current-level="permissionLevel"
          @update:permission-level="$event => emit('update:permissionLevel', $event)"
        />
      </div>
      <div class="toolbar-right">
        <ModelSelector
          :model-id="modelId"
          :model-name="modelName"
          @update:model-id="id => emit('update:modelId', id)"
          @select="(id, name) => emit('select:model', id, name)"
        />
        <button
          v-if="loading && !canSend"
          class="send-btn stop"
          :disabled="cancelling"
          :title="cancelling ? '正在停止...' : '停止'"
          @click="!cancelling && handleStop()"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="2" y="2" width="12" height="12" rx="2"/>
          </svg>
        </button>
        <button
          v-else
          class="send-btn"
          :class="{ active: canSend }"
          :disabled="!canSend"
          :title="loading ? '加入队列 (Ctrl/⌘+Enter)' : '发送 (Ctrl/⌘+Enter)'"
          @click="handleSend()"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 19V5M12 5L5 12M12 5L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { Document, Close, Plus, WarningFilled, FolderOpened, Cloudy, Monitor } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import PermissionLevelSwitcher from './PermissionLevelSwitcher.vue'
import AgentSelector from '../task/AgentSelector.vue'
import ModelSelector from './ModelSelector.vue'
import type { Agent } from '../../stores/agent'

const props = withDefaults(defineProps<{
  disabled?: boolean
  loading?: boolean
  cancelling?: boolean
  workspace?: string
  executionMode?: string
  modelId?: number
  modelName?: string
  modelSupportsVision?: boolean
  placeholder?: string
  permissionLevel?: string
  isNewTask?: boolean
  selectedAgentId?: string | null
  agents?: Agent[]
}>(), {
  disabled: false,
  loading: false,
  cancelling: false,
  workspace: '',
  executionMode: 'CLOUD',
  modelName: '',
  placeholder: '告诉 Agent 你想做什么...',
  permissionLevel: 'READ_ONLY',
  isNewTask: false,
  selectedAgentId: null,
  agents: () => [],
})

const emit = defineEmits<{
  send: [text: string, files: File[]]
  stop: []
  'update:permissionLevel': [level: string]
  'update:executionMode': [mode: string]
  'update:workspace': [workspace: string]
  'update:selectedAgentId': [id: string | null]
  'update:modelId': [modelId: number]
  'select:model': [modelId: number, modelName: string]
}>()

const textareaRef = ref<HTMLTextAreaElement>()
const inputText = ref('')
const pendingFiles = ref<File[]>([])
const filePreviewUrls = ref<string[]>([])

const canSend = computed(() => {
  if (!(inputText.value.trim().length > 0 || pendingFiles.value.length > 0)) return false
  if (props.isNewTask && !props.selectedAgentId) return false
  return true
})

const dirName = computed(() => {
  if (!props.workspace) return ''
  const parts = props.workspace.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || props.workspace
})

function autoResize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 240) + 'px'
}

function handlePaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items
  if (!items) return
  for (const item of Array.from(items)) {
    if (!item.type.startsWith('image/')) continue
    if (pendingFiles.value.length >= 10) {
      ElMessage.warning('最多上传 10 张图片')
      break
    }
    const file = item.getAsFile()
    if (!file) continue
    if (file.size > 10 * 1024 * 1024) {
      ElMessage.warning(`粘贴的图片超过 10MB 限制`)
      continue
    }
    const idx = pendingFiles.value.length
    pendingFiles.value.push(file)
    filePreviewUrls.value[idx] = URL.createObjectURL(file)
  }
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) {
    for (const file of Array.from(input.files)) {
      if (pendingFiles.value.length >= 10) {
        ElMessage.warning('最多上传 10 张图片')
        break
      }
      if (file.size > 10 * 1024 * 1024) {
        ElMessage.warning(`图片 ${file.name} 超过 10MB 限制`)
        continue
      }
      const idx = pendingFiles.value.length
      pendingFiles.value.push(file)
      if (file.type.startsWith('image/')) {
        filePreviewUrls.value[idx] = URL.createObjectURL(file)
      } else {
        filePreviewUrls.value[idx] = ''
      }
    }
  }
  input.value = ''
}

function removeFile(index: number) {
  if (filePreviewUrls.value[index]) {
    URL.revokeObjectURL(filePreviewUrls.value[index])
  }
  pendingFiles.value.splice(index, 1)
  filePreviewUrls.value.splice(index, 1)
}

function handleSend() {
  if (!canSend.value) return
  emit('send', inputText.value.trim(), [...pendingFiles.value])
  inputText.value = ''
  filePreviewUrls.value.forEach(url => { if (url) URL.revokeObjectURL(url) })
  pendingFiles.value = []
  filePreviewUrls.value = []
  nextTick(autoResize)
}

function handleSendKey() {
  handleSend()
}

function openWorkspace() {
  if (!props.workspace) return
  const api = (window as any).electronAPI
  if (api?.openFolder) {
    api.openFolder(props.workspace)
  } else {
    window.open(`file://${props.workspace}`, '_blank')
  }
}

function handleStop() {
  emit('stop')
}

function handleModeChange(mode: string) {
  emit('update:executionMode', mode)
}

async function selectWorkspace() {
  const api = (window as any).electronAPI
  if (api?.selectDirectory) {
    const dir = await api.selectDirectory()
    if (dir) emit('update:workspace', dir)
  }
}

onMounted(autoResize)
</script>

<style scoped>
.chat-input-card {
  margin-bottom: 10px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: 16px;
  padding: 0;
  flex-shrink: 0;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.chat-input-card:focus-within {
  border-color: var(--aw-primary);
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.08);
}

/* Textarea area */
.textarea-area {
  position: relative;
  padding: 16px 16px 4px;
}

.textarea-area.new-task-textarea {
  margin: 0 12px;
  padding: 14px 14px 4px;
  background: var(--aw-canvas-parchment);
  border-radius: 12px;
}

.chat-textarea {
  width: 100%;
  min-height: 24px;
  max-height: 240px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-caption);
  line-height: 1.5;
  color: var(--aw-body);
  padding: 0;
  overflow-y: auto;
}

.chat-textarea::placeholder {
  color: var(--aw-ink-muted-48);
}

.resize-handle {
  position: absolute;
  right: 12px;
  bottom: 6px;
  color: var(--aw-ink-muted-48);
  cursor: nwse-resize;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.resize-handle:hover {
  opacity: 1;
}

/* Pending files */
.pending-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aw-space-xxs);
  padding: 4px 16px 0;
}

.pending-file {
  display: flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  padding: 3px 8px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
}

.file-name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remove-file {
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  transition: color 0.15s;
}

.remove-file:hover {
  color: var(--aw-danger);
}

.file-preview-img {
  width: 32px;
  height: 32px;
  object-fit: cover;
  border-radius: var(--aw-radius-xs);
  flex-shrink: 0;
}

/* Bottom toolbar */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  min-height: 40px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Add button */
.add-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-80);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.add-btn:hover {
  opacity: 0.85;
  transform: scale(1.05);
}

/* Workspace indicator */
.workspace-indicator {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--aw-text-fine);
  color: var(--aw-warning);
  cursor: pointer;
  transition: color 0.15s;
}


.workspace-indicator.has-workspace {
  color: var(--aw-ink-muted-80);
}

.workspace-indicator.cloud-mode {
  color: var(--aw-primary);
  cursor: default;
}

.workspace-indicator span {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mode & model labels */
.mode-label-inline {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  user-select: none;
  padding: 1px 5px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-xs);
  margin-right: 2px;
}

.model-name {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
  user-select: none;
}

/* Send button */
.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
  padding: 0;
}

.send-btn.active {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
}

.send-btn.active:hover {
  background: var(--aw-primary-focus);
  transform: scale(1.05);
}

.send-btn.stop {
  background: var(--aw-danger);
  color: #fff;
}

.send-btn.stop:hover {
  background: color-mix(in srgb, var(--aw-danger) 85%, black);
  transform: scale(1.05);
}

.send-btn.cancelling {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-48);
  opacity: 0.6;
  cursor: default;
}

.send-btn.cancelling:hover {
  transform: none;
}

.send-btn.active:active {
  transform: scale(0.95);
}

.send-btn:disabled {
  cursor: default;
}

/* New task config bar */
.new-task-config-bar {
  padding: 8px 16px 4px;
}

.config-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
}

.config-divider {
  border-top: 1px solid var(--aw-hairline);
}

:deep(.config-row .el-radio-group) {
  --el-radio-button-checked-bg-color: var(--aw-primary);
  --el-radio-button-checked-border-color: var(--aw-primary);
  --el-radio-button-checked-text-color: var(--aw-on-primary);
}

:deep(.config-row .el-radio-button__inner) {
  padding: 5px 12px;
  font-size: var(--aw-text-fine);
  border-color: var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink-muted-80);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s;
}

:deep(.config-row .el-radio-button__original-radio:checked + .el-radio-button__inner) {
  background-color: var(--aw-primary);
  border-color: var(--aw-primary);
  color: var(--aw-on-primary);
}

.workspace-selector {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-hairline);
  border-radius: 999px;
  cursor: pointer;
  font-size: var(--aw-text-fine);
  color: var(--aw-warning);
  transition: border-color 0.15s;
}

.workspace-selector:hover {
  border-color: var(--aw-primary);
}

.workspace-selector.has-workspace {
  color: var(--aw-ink-muted-80);
}

.workspace-selector span {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
