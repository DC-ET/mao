<template>
  <div class="chat-input-card">
    <!-- Textarea area -->
    <div class="textarea-area">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="chat-textarea"
        :placeholder="placeholder"
        rows="1"
        @input="autoResize"
        @keydown.enter.ctrl.prevent="handleSend"
        @keydown.enter.meta.prevent="handleSend"
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
        <el-icon><Document /></el-icon>
        <span class="file-name">{{ file.name }}</span>
        <el-icon class="remove-file" @click="removeFile(idx)"><Close /></el-icon>
      </div>
    </div>

    <!-- Bottom toolbar -->
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="add-btn" title="上传文件">
          <input type="file" multiple @change="handleFileSelect" style="display: none" />
          <el-icon :size="16"><Plus /></el-icon>
        </label>
        <div class="workspace-indicator" :class="{ 'has-workspace': !!workspace }">
          <el-icon :size="14">
            <WarningFilled v-if="!workspace" />
            <FolderOpened v-else />
          </el-icon>
          <span>{{ dirName || 'No workspace' }}</span>
        </div>
      </div>
      <div class="toolbar-right">
        <span class="mode-label">{{ executionMode === 'LOCAL' ? '本地' : '云端' }}</span>
        <span class="model-name">{{ modelName }}</span>
        <button
          class="send-btn"
          :class="{ active: canSend, loading }"
          :disabled="!canSend"
          title="发送 (Ctrl/⌘+Enter)"
          @click="handleSend"
        >
          <el-icon v-if="loading" :size="18" class="spinner"><Loading /></el-icon>
          <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 19V5M12 5L5 12M12 5L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { Document, Close, Plus, WarningFilled, FolderOpened, Loading } from '@element-plus/icons-vue'

const props = withDefaults(defineProps<{
  disabled?: boolean
  loading?: boolean
  workspace?: string
  executionMode?: string
  modelName?: string
  placeholder?: string
}>(), {
  disabled: false,
  loading: false,
  workspace: '',
  executionMode: 'CLOUD',
  modelName: 'gpt-5.4',
  placeholder: '描述你希望 Agent 完成的任务',
})

const emit = defineEmits<{
  send: [text: string, files: File[]]
}>()

const textareaRef = ref<HTMLTextAreaElement>()
const inputText = ref('')
const pendingFiles = ref<File[]>([])

const canSend = computed(() =>
  (inputText.value.trim().length > 0 || pendingFiles.value.length > 0)
)

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

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) {
    for (const file of Array.from(input.files)) {
      pendingFiles.value.push(file)
    }
  }
  input.value = ''
}

function removeFile(index: number) {
  pendingFiles.value.splice(index, 1)
}

function handleSend() {
  if (!canSend.value) return
  emit('send', inputText.value.trim(), [...pendingFiles.value])
  inputText.value = ''
  pendingFiles.value = []
  nextTick(autoResize)
}

onMounted(autoResize)
</script>

<style scoped>
.chat-input-card {
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

.chat-textarea {
  width: 100%;
  min-height: 24px;
  max-height: 240px;
  border: none;
  outline: none;
  resize: none;
  background: transparent;
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-body);
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
  background: var(--aw-surface-black);
  color: var(--aw-body-on-dark);
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

.workspace-indicator span {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Mode & model labels */
.mode-label {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  user-select: none;
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

.send-btn.active:active {
  transform: scale(0.95);
}

.send-btn:disabled {
  cursor: default;
}

.spinner {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
