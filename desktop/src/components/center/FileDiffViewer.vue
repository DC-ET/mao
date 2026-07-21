<template>
  <div class="file-diff-viewer">
    <div v-if="mode === 'SNAPSHOT'" ref="diffContainer" class="monaco-diff-container"></div>

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

const props = defineProps<{
  change: FileChange
}>()

const sessionStore = useSessionStore()
const activeSessionIdRef = computed(() => sessionStore.activeSessionId ?? '')
const { openFileTab } = useCenterTabs(activeSessionIdRef)
const { isDark } = useTheme()

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

watch(
  [() => props.change, isDark],
  () => { void syncViewer() },
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
</style>
