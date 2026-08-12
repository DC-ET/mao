<template>
  <el-dialog
    :model-value="visible"
    title="下载文件"
    width="min(400px, calc(100vw - 32px))"
    :close-on-click-modal="false"
    @close="$emit('close')"
  >
    <div class="download-link-content">
      <p class="download-hint">
        自动下载可能受限，请使用以下链接手动下载：
      </p>
      <div class="link-container">
        <a :href="url" target="_blank" rel="noopener noreferrer" class="download-link">
          {{ fileName || '点击下载' }}
        </a>
      </div>
      <div class="url-display">
        <input
          ref="urlInput"
          type="text"
          :value="url"
          readonly
          class="url-input"
          @click="selectUrl"
        />
      </div>
    </div>
    <template #footer>
      <div class="dialog-footer">
        <el-button size="small" @click="copyLink">复制链接</el-button>
        <el-button size="small" type="primary" @click="$emit('close')">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { ElDialog, ElButton, ElMessage } from 'element-plus'
import { copyText } from '../../utils/clipboard'

const props = defineProps<{
  visible: boolean
  url: string
  fileName?: string
}>()

defineEmits<{
  close: []
}>()

const urlInput = ref<HTMLInputElement>()

function selectUrl() {
  urlInput.value?.select()
}

function copyLink() {
  copyText(props.url)
  ElMessage.success('链接已复制到剪贴板')
}
</script>

<style scoped>
.download-link-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.download-hint {
  margin: 0;
  color: var(--aw-ink-muted);
  font-size: 14px;
  line-height: 1.5;
}

.link-container {
  text-align: center;
  padding: 8px 0;
}

.download-link {
  color: var(--aw-primary);
  text-decoration: none;
  font-size: 16px;
  font-weight: 500;
}

.download-link:hover {
  text-decoration: underline;
}

.url-display {
  margin-top: 4px;
}

.url-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 4px;
  font-size: 12px;
  font-family: monospace;
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  cursor: text;
}

.url-input:focus {
  outline: none;
  border-color: var(--aw-primary);
  box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.2);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>