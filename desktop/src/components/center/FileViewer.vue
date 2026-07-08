<template>
  <div class="file-viewer" v-loading="state === 'loading'">
    <!-- Error state -->
    <div v-if="state === 'error'" class="file-message error">
      <p>文件读取失败：{{ errorMsg }}</p>
      <button class="retry-btn" @click="loadFile">重试</button>
    </div>

    <!-- Image preview -->
    <div v-else-if="state === 'image'" class="file-message image-preview">
      <img :src="imageDataUri" :alt="filePath" />
      <p class="image-meta">{{ content }}</p>
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
      <div v-if="isMarkdown" class="view-mode-toggle">
        <button :class="['mode-btn', { active: viewMode === 'rendered' }]" @click="viewMode = 'rendered'">预览</button>
        <button :class="['mode-btn', { active: viewMode === 'source' }]" @click="viewMode = 'source'">源码</button>
      </div>
      <div class="file-editor-area">
        <div
          v-show="showSource"
          ref="monacoContainer"
          class="monaco-container"
        ></div>
        <div v-show="!showSource" class="file-scroll" @click="handleMarkdownClick">
          <MarkdownContent :content="content" body-class="markdown-body" />
        </div>
      </div>
      <div v-if="truncated" class="truncation-notice">
        仅显示前 5000 行
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, toRef } from 'vue'
import { useMonacoViewer } from '../../composables/useMonacoViewer'
import MarkdownContent from '../common/MarkdownContent.vue'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useSessionStore } from '../../stores/session'
import { useTheme } from '../../utils/theme'
import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  filePath: string
  provider: WorkspaceFileProvider | null
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { openFileTab } = useCenterTabs(activeSessionIdRef)

type LoadState = 'loading' | 'ready' | 'error' | 'binary' | 'empty' | 'image'

const state = ref<LoadState>('loading')
const content = ref('')
const imageDataUri = ref('')
const monacoContainer = ref<HTMLElement>()
const viewMode = ref<'source' | 'rendered'>('source')
const { isDark } = useTheme()

const isMarkdown = computed(() => {
  const ext = props.filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
})

const showSource = computed(() => !isMarkdown.value || viewMode.value === 'source')

const monacoEnabled = computed(() => state.value === 'ready' && showSource.value)

useMonacoViewer({
  container: monacoContainer,
  content,
  filePath: toRef(props, 'filePath'),
  isDark,
  enabled: monacoEnabled,
})

async function handleMarkdownClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest('a')
  if (!anchor) return

  const href = anchor.getAttribute('href')
  if (!href) return

  e.preventDefault()

  if (isExternalMarkdownLink(href)) {
    await window.electronAPI?.openExternal(href)
    return
  }

  const resolvedPath = resolveMarkdownLink(props.filePath, href)
  if (!resolvedPath) return

  const title = resolvedPath.split(/[/\\]/).pop() || resolvedPath
  openFileTab(resolvedPath, title)
}

const totalLines = ref(0)
const errorMsg = ref('')
const truncated = ref(false)

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
  if (!props.provider) {
    state.value = 'error'
    errorMsg.value = '工作区未就绪，请稍后再试'
    return
  }
  state.value = 'loading'
  content.value = ''
  imageDataUri.value = ''
  errorMsg.value = ''
  truncated.value = false

  try {
    const result = await props.provider.readFile(props.filePath, { limit: 5000 })

    if (result.error) {
      state.value = 'error'
      errorMsg.value = result.error
      return
    }

    if (result.media_type === 'image' && result.data_uri) {
      content.value = result.content
      imageDataUri.value = result.data_uri
      state.value = 'image'
      return
    }

    if (result.total_lines === 0 && !result.content) {
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

watch(() => [props.filePath, props.provider] as const, () => {
  viewMode.value = 'source'
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

.image-preview {
  padding: 24px;
  gap: 12px;
}

.image-preview img {
  max-width: 100%;
  max-height: calc(100% - 48px);
  object-fit: contain;
  border-radius: var(--aw-radius-sm);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
}

.image-meta {
  margin: 12px 0 0 !important;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  min-height: 0;
}

.file-editor-area {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.monaco-container {
  width: 100%;
  height: 100%;
}

.file-scroll {
  height: 100%;
  overflow: auto;
}

.view-mode-toggle {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 2px;
  z-index: 10;
}

.mode-btn {
  padding: 3px 10px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  transition: all 0.15s;
  backdrop-filter: blur(8px);
}

.mode-btn:hover {
  color: var(--aw-ink);
}

.mode-btn.active {
  color: var(--aw-primary);
  border-color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.06);
}

.markdown-body {
  flex: 1;
  padding: 16px 24px;
  overflow: auto;
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: var(--aw-font-display);
  font-weight: 600;
  color: var(--aw-ink);
  margin: 4px 0 2px;
  letter-spacing: 0;
}

.markdown-body :deep(h1) { font-size: var(--aw-text-lead); }
.markdown-body :deep(h2) { font-size: var(--aw-text-tagline); }
.markdown-body :deep(h3) { font-size: var(--aw-text-body); }
.markdown-body :deep(h4) { font-size: var(--aw-text-caption); }

.markdown-body :deep(p) {
  margin: 0;
  font-size: var(--aw-text-caption);
  line-height: 2;
  letter-spacing: -0.374px;
}

.markdown-body :deep(a) {
  color: var(--aw-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) { text-decoration: underline; }

.markdown-body :deep(code) {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(pre) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block) {
  margin: 2px 0;
  border-radius: var(--aw-radius-sm);
  overflow: hidden;
}

.markdown-body :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--aw-surface-code-header);
  font-size: var(--aw-text-fine);
}

.markdown-body :deep(.code-lang) {
  color: var(--aw-ink-muted-48);
  font-family: var(--aw-font-mono);
  text-transform: uppercase;
  letter-spacing: 0;
}

.markdown-body :deep(.code-copy-btn) {
  background: none;
  border: 1px solid var(--aw-hairline);
  color: var(--aw-ink-muted-48);
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}

.markdown-body :deep(.code-copy-btn:hover) {
  color: var(--aw-ink);
  border-color: var(--aw-ink-muted-48);
}

.markdown-body :deep(.monaco-code) {
  display: block;
  padding: 12px;
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 20px;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 2px 0;
  padding-left: 20px;
}

.markdown-body :deep(li) {
  font-size: var(--aw-text-caption);
  line-height: 2;
  letter-spacing: -0.374px;
}

.markdown-body :deep(blockquote) {
  margin: 2px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--aw-primary);
  color: var(--aw-ink-muted-80);
  background: var(--aw-canvas-parchment);
  border-radius: 0 var(--aw-radius-xs) var(--aw-radius-xs) 0;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 2px 0;
  width: 100%;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--aw-hairline);
  padding: 6px 10px;
  text-align: left;
  font-size: var(--aw-text-caption);
}

.markdown-body :deep(th) {
  background: var(--aw-canvas-parchment);
  font-weight: 600;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--aw-divider-soft);
  margin: 2px 0;
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
.file-scroll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.file-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.file-scroll::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}

/* Dark mode */
[data-theme="dark"] .truncation-notice {
  border-top-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}
</style>
