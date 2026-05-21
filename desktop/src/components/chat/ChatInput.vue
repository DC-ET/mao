<template>
  <div class="chat-input-container">
    <div v-if="pendingFiles.length > 0" class="pending-files">
      <div v-for="(file, idx) in pendingFiles" :key="idx" class="pending-file">
        <el-icon><Document /></el-icon>
        <span class="file-name">{{ file.name }}</span>
        <el-icon class="remove-file" @click="removeFile(idx)"><Close /></el-icon>
      </div>
    </div>
    <div class="input-row">
      <label class="attach-btn" title="上传文件">
        <input type="file" multiple @change="handleFileSelect" style="display: none" />
        <el-icon :size="18"><Paperclip /></el-icon>
      </label>
      <el-input
        ref="inputRef"
        v-model="inputText"
        type="textarea"
        :autosize="{ minRows: 1, maxRows: 8 }"
        placeholder="继续说明本次任务... (Ctrl/⌘+Enter 发送)"
        :disabled="disabled"
        @keydown.enter.ctrl.prevent="handleSend"
        @keydown.enter.meta.prevent="handleSend"
      />
      <el-button
        type="primary"
        :loading="loading"
        :disabled="!canSend"
        class="send-btn"
        @click="handleSend"
      >
        <el-icon v-if="!loading"><Promotion /></el-icon>
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Document, Close, Paperclip, Promotion } from '@element-plus/icons-vue'

defineProps<{
  disabled: boolean
  loading: boolean
}>()

const emit = defineEmits<{
  send: [text: string, files: File[]]
}>()

const inputText = ref('')
const pendingFiles = ref<File[]>([])

const canSend = computed(() =>
  (inputText.value.trim().length > 0 || pendingFiles.value.length > 0)
)

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
}
</script>

<style scoped>
.chat-input-container {
  padding: 12px 0 0;
  border-top: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.pending-files {
  display: flex;
  flex-wrap: wrap;
  gap: var(--aw-space-xs);
  margin-bottom: var(--aw-space-xs);
}

.pending-file {
  display: flex;
  align-items: center;
  gap: var(--aw-space-xxs);
  padding: 4px 10px;
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

.input-row {
  display: flex;
  gap: var(--aw-space-xs);
  align-items: flex-end;
}

.input-row :deep(.el-textarea__inner) {
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-body);
  line-height: 1.47;
  letter-spacing: -0.374px;
  padding: 10px 16px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-pill);
  color: var(--aw-body);
  resize: none;
}

.input-row :deep(.el-textarea__inner:focus) {
  border-color: var(--aw-primary);
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.15);
}

.input-row :deep(.el-textarea) {
  flex: 1;
}

.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  transition: all 0.15s;
  flex-shrink: 0;
  background: var(--aw-canvas-parchment);
}

.attach-btn:hover {
  color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.08);
}

.send-btn {
  height: 44px;
  width: 44px;
  padding: 0;
  flex-shrink: 0;
  border-radius: 50% !important;
}

.send-btn:active {
  transform: scale(0.95);
}
</style>
