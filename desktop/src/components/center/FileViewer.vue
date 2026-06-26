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
    <div v-else-if="state === 'ready'" class="file-content" @keydown="handleKeydown">
      <div class="code-container">
        <div class="line-numbers">
          <div v-for="i in lineCount" :key="i" class="line-number">{{ i }}</div>
        </div>
        <pre ref="codeEl" class="code-text" tabindex="0"><code class="hljs" v-html="highlightedContent"></code></pre>
      </div>
      <div v-if="truncated" class="truncation-notice">
        仅显示前 5000 行
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import hljs from 'highlight.js'

const props = defineProps<{
  filePath: string
}>()

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
  background: var(--aw-surface-code);
}

[data-theme="dark"] .truncation-notice {
  border-top-color: var(--aw-hairline);
  background: rgba(255, 255, 255, 0.03);
}
</style>
