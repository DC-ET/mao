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
      <div v-if="isMarkdown" class="view-mode-toggle">
        <button :class="['mode-btn', { active: viewMode === 'rendered' }]" @click="viewMode = 'rendered'">预览</button>
        <button :class="['mode-btn', { active: viewMode === 'source' }]" @click="viewMode = 'source'">源码</button>
      </div>
      <div class="file-scroll" @keydown="handleKeydown">
        <div v-if="!isMarkdown || viewMode === 'source'" class="code-container">
          <div class="line-numbers">
            <div v-for="i in lineCount" :key="i" class="line-number">{{ i }}</div>
          </div>
          <pre ref="codeEl" class="code-text" tabindex="0"><code class="hljs" v-html="highlightedContent"></code></pre>
        </div>
        <div v-else class="markdown-body" v-html="renderedContent" @click="handleMarkdownClick"></div>
        <div v-if="truncated" class="truncation-notice">
          仅显示前 5000 行
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import hljs from 'highlight.js'
import { renderMarkdown } from '../../composables/useMarkdown'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useSessionStore } from '../../stores/session'
import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  filePath: string
  provider: WorkspaceFileProvider | null
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { openFileTab } = useCenterTabs(activeSessionIdRef)

type LoadState = 'loading' | 'ready' | 'error' | 'binary' | 'empty'

const EXT_LANG_MAP: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', kts: 'kotlin',
  go: 'go', rs: 'rust', c: 'cpp', h: 'cpp', hpp: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  cs: 'csharp', swift: 'swift', dart: 'dart', scala: 'scala', clj: 'clojure',
  php: 'php', lua: 'lua', r: 'r', m: 'objectivec', mm: 'objectivec',
  sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell', bat: 'batch', cmd: 'batch',
  html: 'html', htm: 'html', vue: 'xml', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', markdown: 'markdown',
  graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile', makefile: 'makefile',
  ini: 'ini', cfg: 'ini', conf: 'nginx',
  txt: 'plaintext', log: 'plaintext', csv: 'plaintext',
}

function langFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  if (['makefile', 'dockerfile'].some(f => filePath.toLowerCase().endsWith(f))) {
    return filePath.toLowerCase().endsWith('dockerfile') ? 'dockerfile' : 'makefile'
  }
  return EXT_LANG_MAP[ext] || 'plaintext'
}

const state = ref<LoadState>('loading')
const content = ref('')
const codeEl = ref<HTMLElement>()
const viewMode = ref<'source' | 'rendered'>('source')

const isMarkdown = computed(() => {
  const ext = props.filePath.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
})

const renderedContent = computed(() => {
  if (!content.value) return ''
  return renderMarkdown(content.value)
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

function handleKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
    e.preventDefault()
    const el = codeEl.value
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
}
const totalLines = ref(0)
const errorMsg = ref('')
const truncated = ref(false)

const lineCount = computed(() => {
  if (!content.value) return 0
  return content.value.split('\n').length
})

const highlightedContent = computed(() => {
  if (!content.value) return ''
  const lang = langFromExtension(props.filePath)
  if (lang === 'plaintext') return escapeHtml(content.value)
  try {
    return hljs.highlight(content.value, { language: lang }).value
  } catch {
    return escapeHtml(content.value)
  }
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function isBinaryContent(text: string): boolean {
  // Check first 8KB for null bytes
  const checkLen = Math.min(text.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (text.charCodeAt(i) === 0) return true
  }
  return false
}

async function loadFile() {
  if (!props.filePath || !props.provider) return
  state.value = 'loading'
  content.value = ''
  errorMsg.value = ''
  truncated.value = false

  try {
    const result = await props.provider.readFile(props.filePath, { limit: 5000 })

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
  overflow: hidden;
  position: relative;
}

.file-scroll {
  height: 100%;
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
  background: var(--aw-surface-code);
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
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  line-height: 20px;
  color: var(--aw-ink);
  white-space: pre;
  word-wrap: normal;
  overflow-x: auto;
  background: var(--aw-surface-code);
}

.code-text code {
  font-family: inherit;
}

.code-text :deep(.hljs) {
  color: var(--aw-ink);
  background: var(--aw-surface-code);
  padding: 0;
  margin: 0;
}

.code-text :deep(.hljs-keyword) { color: #ff7b72; }
.code-text :deep(.hljs-subst) { color: #9a9a9a; }
.code-text :deep(.hljs-string) { color: #a5d6ff; }
.code-text :deep(.hljs-number) { color: #79c0ff; }
.code-text :deep(.hljs-comment) { color: #8b949e; font-style: italic; }
.code-text :deep(.hljs-function) { color: #d2a8ff; }
.code-text :deep(.hljs-title) { color: #d2a8ff; }
.code-text :deep(.hljs-params) { color: #c9d1d9; }
.code-text :deep(.hljs-built_in) { color: #ffa657; }
.code-text :deep(.hljs-type) { color: #ff7b72; }
.code-text :deep(.hljs-attr) { color: #79c0ff; }
.code-text :deep(.hljs-literal) { color: #79c0ff; }
.code-text :deep(.hljs-symbol) { color: #79c0ff; }
.code-text :deep(.hljs-meta) { color: #79c0ff; }
.code-text :deep(.hljs-tag) { color: #7ee787; }
.code-text :deep(.hljs-name) { color: #7ee787; }
.code-text :deep(.hljs-attribute) { color: #79c0ff; }
.code-text :deep(.hljs-selector-tag) { color: #7ee787; }
.code-text :deep(.hljs-selector-class) { color: #79c0ff; }
.code-text :deep(.hljs-selector-id) { color: #d2a8ff; }
.code-text :deep(.hljs-variable) { color: #ffa657; }
.code-text :deep(.hljs-template-variable) { color: #ffa657; }
.code-text :deep(.hljs-regexp) { color: #a5d6ff; }
.code-text :deep(.hljs-addition) { color: #aff5b4; background: rgba(46, 160, 67, 0.15); }
.code-text :deep(.hljs-deletion) { color: #ffdcd7; background: rgba(248, 81, 73, 0.15); }
.code-text :deep(.hljs-emphasis) { font-style: italic; }
.code-text :deep(.hljs-strong) { font-weight: bold; }

[data-theme="light"] .code-text :deep(.hljs) { color: #24292f; }
[data-theme="light"] .code-text :deep(.hljs-keyword) { color: #cf222e; }
[data-theme="light"] .code-text :deep(.hljs-string) { color: #0a3069; }
[data-theme="light"] .code-text :deep(.hljs-number) { color: #0550ae; }
[data-theme="light"] .code-text :deep(.hljs-comment) { color: #6e7781; font-style: italic; }
[data-theme="light"] .code-text :deep(.hljs-function) { color: #8250df; }
[data-theme="light"] .code-text :deep(.hljs-title) { color: #8250df; }
[data-theme="light"] .code-text :deep(.hljs-built_in) { color: #953800; }
[data-theme="light"] .code-text :deep(.hljs-type) { color: #cf222e; }
[data-theme="light"] .code-text :deep(.hljs-attr) { color: #0550ae; }
[data-theme="light"] .code-text :deep(.hljs-tag) { color: #116329; }
[data-theme="light"] .code-text :deep(.hljs-name) { color: #116329; }
[data-theme="light"] .code-text :deep(.hljs-variable) { color: #953800; }
[data-theme="light"] .code-text :deep(.hljs-addition) { color: #116329; background: rgba(46, 160, 67, 0.1); }
[data-theme="light"] .code-text :deep(.hljs-deletion) { color: #82071e; background: rgba(248, 81, 73, 0.1); }

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

.markdown-body :deep(.hljs) {
  padding: 12px;
  background: var(--aw-surface-code);
  color: var(--aw-text-code);
  overflow-x: auto;
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
[data-theme="dark"] .line-numbers {
  background: var(--aw-surface-code);
}

[data-theme="dark"] .truncation-notice {
  border-top-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}
</style>
