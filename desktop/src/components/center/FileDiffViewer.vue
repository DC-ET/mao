<template>
  <div class="file-diff-viewer">
    <!-- View mode toggle for new files (preview/source) -->
    <div v-if="showPreviewToggle" class="view-mode-toggle">
      <button :class="['mode-btn', { active: viewMode === 'preview' }]" @click="viewMode = 'preview'">预览</button>
      <button :class="['mode-btn', { active: viewMode === 'source' }]" @click="viewMode = 'source'">源码</button>
    </div>

    <div v-if="mode === 'SNAPSHOT' && showSource" ref="diffContainer" class="monaco-diff-container"></div>
    <div v-else-if="mode === 'SNAPSHOT' && !showSource" class="preview-container" @click="handleMarkdownClick">
      <MarkdownContent :content="change.afterContent || ''" body-class="markdown-body" />
    </div>

    <div v-else-if="mode === 'PATCH'" class="patch-view">
      <div v-if="change.patchTruncated" class="diff-notice">Patch 已截断，仅显示前 256 KiB</div>
      <div ref="patchContainer" class="monaco-patch-container"></div>
    </div>

    <div v-else class="diff-message">
      <p>{{ unavailableText }}</p>
      <button class="open-file-btn" @click="openCurrentFile">打开当前文件</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { editor as MonacoEditor } from 'monaco-editor'
import type { FileChange } from '../../types/chat'
import { applyMonacoTheme, loadMonaco, themeName } from '../../utils/monaco-loader'
import { monacoLangFromExtension } from '../../utils/monaco-lang'
import { useTheme } from '../../utils/theme'
import { useCenterTabs } from '../../composables/useCenterTabs'
import { useSessionStore } from '../../stores/session'
import MarkdownContent from '../common/MarkdownContent.vue'
import { isExternalMarkdownLink, resolveMarkdownLink } from '../../utils/markdown-link'

const props = defineProps<{
  change: FileChange
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { openFileTab } = useCenterTabs(activeSessionIdRef)
const { isDark } = useTheme()

const viewMode = ref<'preview' | 'source'>('preview')

const diffContainer = ref<HTMLElement>()
const patchContainer = ref<HTMLElement>()

let diffEditor: MonacoEditor.IStandaloneDiffEditor | null = null
let patchEditor: MonacoEditor.IStandaloneCodeEditor | null = null
let originalModel: MonacoEditor.ITextModel | null = null
let modifiedModel: MonacoEditor.ITextModel | null = null
let patchModel: MonacoEditor.ITextModel | null = null
let diffUpdateDisposable: { dispose: () => void } | null = null

const mode = computed(() => props.change.diffMode || 'UNSUPPORTED')
const unavailableText = computed(() => {
  return props.change.diffUnavailableReason || '该历史变更没有可用的 diff 数据'
})

const isMarkdown = computed(() => {
  const ext = props.change.path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown'
})

const isNewFile = computed(() => {
  return props.change.type === 'CREATED' || !props.change.beforeContent
})

const showPreviewToggle = computed(() => {
  return mode.value === 'SNAPSHOT' && isNewFile.value && isMarkdown.value
})

const showSource = computed(() => {
  return !showPreviewToggle.value || viewMode.value === 'source'
})

function disposeDiffEditor() {
  diffUpdateDisposable?.dispose()
  diffUpdateDisposable = null
  diffEditor?.dispose()
  diffEditor = null
  originalModel?.dispose()
  originalModel = null
  modifiedModel?.dispose()
  modifiedModel = null
}

function revealFirstDiffChange() {
  if (!diffEditor) return
  const changes = diffEditor.getLineChanges()
  if (!changes?.length) return
  const first = changes[0]
  if (first.modifiedStartLineNumber > 0) {
    diffEditor.getModifiedEditor().revealLineInCenter(first.modifiedStartLineNumber)
  } else if (first.originalStartLineNumber > 0) {
    diffEditor.getOriginalEditor().revealLineInCenter(first.originalStartLineNumber)
  }
}

function disposePatchEditor() {
  patchEditor?.dispose()
  patchEditor = null
  patchModel?.dispose()
  patchModel = null
}

function disposeAll() {
  disposeDiffEditor()
  disposePatchEditor()
}

async function syncViewer() {
  await nextTick()
  const monaco = await loadMonaco()
  await applyMonacoTheme(isDark.value)

  if (mode.value === 'SNAPSHOT') {
    disposePatchEditor()
    if (!diffContainer.value) return
    const language = monacoLangFromExtension(props.change.path)
    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(diffContainer.value, {
        theme: themeName(isDark.value),
        readOnly: true,
        domReadOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
        renderLineHighlight: 'none',
        overviewRulerLanes: 2,
        contextmenu: true,
        unicodeHighlight: { ambiguousCharacters: false },
      })
    }
    originalModel?.dispose()
    modifiedModel?.dispose()
    originalModel = monaco.editor.createModel(props.change.beforeContent || '', language)
    modifiedModel = monaco.editor.createModel(props.change.afterContent || '', language)
    diffEditor.setModel({ original: originalModel, modified: modifiedModel })

    diffUpdateDisposable?.dispose()
    diffUpdateDisposable = diffEditor.onDidUpdateDiff(() => {
      revealFirstDiffChange()
      diffUpdateDisposable?.dispose()
      diffUpdateDisposable = null
    })
    // Diff may already be ready synchronously for small files
    revealFirstDiffChange()
    return
  }

  if (mode.value === 'PATCH') {
    disposeDiffEditor()
    if (!patchContainer.value) return
    const value = props.change.patchContent || ''
    if (!patchEditor) {
      patchModel = monaco.editor.createModel(value, 'diff')
      patchEditor = monaco.editor.create(patchContainer.value, {
        model: patchModel,
        theme: themeName(isDark.value),
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
        lineNumbers: 'on',
        automaticLayout: true,
        renderLineHighlight: 'none',
        overviewRulerLanes: 0,
        contextmenu: true,
        unicodeHighlight: { ambiguousCharacters: false },
      })
    } else if (patchModel && patchModel.getValue() !== value) {
      patchModel.setValue(value)
    }
    return
  }

  disposeAll()
}

function openCurrentFile() {
  const title = props.change.path.split(/[/\\]/).pop() || props.change.path
  openFileTab(props.change.path, title)
}

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

  const resolvedPath = resolveMarkdownLink(props.change.path, href)
  if (!resolvedPath) return

  const title = resolvedPath.split(/[/\\]/).pop() || resolvedPath
  openFileTab(resolvedPath, title)
}

watch(
  [() => props.change, isDark],
  () => {
    // Reset view mode when file changes
    viewMode.value = 'preview'
    void syncViewer()
  },
  { deep: true, flush: 'post', immediate: true },
)

onBeforeUnmount(disposeAll)
</script>

<style scoped>
.file-diff-viewer {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--aw-surface);
  overflow: hidden;
  position: relative;
}

.monaco-diff-container,
.monaco-patch-container {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.patch-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.diff-notice {
  padding: 8px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  color: var(--aw-ink-muted-64);
  font-size: var(--aw-text-caption);
  background: var(--aw-canvas);
}

.diff-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.diff-message p {
  margin: 0;
}

.open-file-btn {
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
  padding: 4px 14px;
}

.open-file-btn:hover {
  background: rgba(0, 102, 204, 0.08);
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

.preview-container {
  flex: 1;
  overflow: auto;
  padding: 16px 24px;
}

.markdown-body {
  flex: 1;
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
</style>
