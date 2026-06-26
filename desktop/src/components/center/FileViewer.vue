<template>
  <div class="file-viewer" v-loading="state === 'loading'">
    <!-- Error state -->
    <div v-if="state === 'error'" class="file-message error">
      <p>文件读取失败：{{ errorMsg }}</p>
      <button class="retry-btn" @click="loadFile">重试</button>
    </div>

    <!-- Binary file -->
    <div v-else-if="state === 'binary'" class="file-message">
      <p>二进制文件，无法预览</p>
    </div>

    <!-- Empty file -->
    <div v-else-if="state === 'empty'" class="file-message">
      <p>空文件</p>
    </div>

    <!-- Content -->
    <div v-else-if="state === 'ready'" class="file-content">
      <div class="code-container">
        <div class="line-numbers">
          <div v-for="i in lineCount" :key="i" class="line-number">{{ i }}</div>
        </div>
        <pre class="code-text"><code>{{ content }}</code></pre>
      </div>
      <div v-if="truncated" class="truncation-notice">
        仅显示前 5000 行
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'

const props = defineProps<{
  filePath: string
}>()

type LoadState = 'loading' | 'ready' | 'error' | 'binary' | 'empty'

const state = ref<LoadState>('loading')
const content = ref('')
const totalLines = ref(0)
const errorMsg = ref('')
const truncated = ref(false)

const lineCount = computed(() => {
  if (!content.value) return 0
  return content.value.split('\n').length
})

function isBinaryContent(text: string): boolean {
  // Check first 8KB for null bytes
  const checkLen = Math.min(text.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true
  }
  return false
}

async function loadFile() {
  if (!props.filePath) return
  state.value = 'loading'
  content.value = ''
  errorMsg.value = ''
  truncated.value = false

  try {
    const result = await window.electronAPI.localReadFile({
      path: props.filePath,
      limit: 5000
    })

    if (result.error) {
      state.value = 'error'
      errorMsg.value = result.error
      return
    }

    if (result.total_lines === 0) {
      state.value = 'empty'
      totalLines.value = 0
      return
    }

    // Binary detection
    if (isBinaryContent(result.content)) {
      state.value = 'binary'
      return
    }

    content.value = result.content
    totalLines.value = result.total_lines
    truncated.value = result.total_lines > 5000
    state.value = 'ready'
  } catch (e: any) {
    state.value = 'error'
    errorMsg.value = e.message || '未知错误'
  }
}

onMounted(loadFile)

watch(() => props.filePath, () => {
  loadFile()
})
</script>

<style scoped>
.file-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--aw-surface);
}

.file-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.file-message.error {
  color: var(--aw-danger);
}

.file-message p {
  margin: 0 0 12px;
}

.retry-btn {
  font-size: var(--aw-text-caption);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 4px 16px;
  cursor: pointer;
}

.retry-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

.file-content {
  flex: 1;
  overflow: auto;
}

.code-container {
  display: flex;
  min-height: 100%;
}

.line-numbers {
  flex-shrink: 0;
  padding: 12px 0;
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
}

.line-number {
  padding: 0 12px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  line-height: 20px;
}

.code-text {
  flex: 1;
  margin: 0;
  padding: 12px 16px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 20px;
  color: var(--aw-ink);
  white-space: pre;
  word-wrap: normal;
  overflow-x: auto;
}

.code-text code {
  font-family: inherit;
}

.truncation-notice {
  padding: 8px 16px;
  text-align: center;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  border-top: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
}

/* Scrollbar */
.file-content::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.file-content::-webkit-scrollbar-track {
  background: transparent;
}

.file-content::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}

/* Dark mode */
[data-theme="dark"] .line-numbers {
  border-right-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}

[data-theme="dark"] .truncation-notice {
  border-top-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}
</style>
