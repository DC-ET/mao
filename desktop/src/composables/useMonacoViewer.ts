import { watch, onBeforeUnmount, nextTick, type Ref } from 'vue'
import type { editor as MonacoEditor } from 'monaco-editor'
import { applyMonacoTheme, loadMonaco, themeName } from '../utils/monaco-loader'
import { monacoLangFromExtension } from '../utils/monaco-lang'

export function useMonacoViewer(options: {
  container: Ref<HTMLElement | undefined>
  content: Ref<string>
  filePath: Ref<string>
  isDark: Ref<boolean>
  enabled: Ref<boolean>
}) {
  let editor: MonacoEditor.IStandaloneCodeEditor | null = null

  function disposeEditor(): void {
    editor?.dispose()
    editor = null
  }

  async function syncEditor(): Promise<void> {
    if (!options.enabled.value) {
      disposeEditor()
      return
    }

    await nextTick()
    if (!options.container.value) return

    const monaco = await loadMonaco()
    await applyMonacoTheme(options.isDark.value)

    const language = monacoLangFromExtension(options.filePath.value)
    const value = options.content.value

    if (!editor) {
      editor = monaco.editor.create(options.container.value, {
        value,
        language,
        theme: themeName(options.isDark.value),
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 14,
        lineHeight: 20,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, 'SF Mono', Menlo, Monaco, monospace",
        lineNumbers: 'on',
        wordWrap: 'off',
        automaticLayout: true,
        renderLineHighlight: 'none',
        glyphMargin: false,
        folding: true,
        padding: { top: 12 },
        scrollbar: {
          verticalScrollbarSize: 6,
          horizontalScrollbarSize: 6,
        },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        overviewRulerBorder: false,
        contextmenu: true,
        links: true,
        cursorBlinking: 'solid',
        cursorStyle: 'line',
        renderValidationDecorations: 'off',
        unicodeHighlight: { ambiguousCharacters: false },
      })
      return
    }

    const model = editor.getModel()
    if (!model) return

    if (model.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(model, language)
    }
    if (model.getValue() !== value) {
      editor.setValue(value)
    }
  }

  watch(
    [options.enabled, options.container, options.content, options.filePath],
    () => { void syncEditor() },
    { flush: 'post' },
  )

  watch(options.isDark, async () => {
    await applyMonacoTheme(options.isDark.value)
    if (editor) {
      const monaco = await loadMonaco()
      editor.updateOptions({ theme: themeName(options.isDark.value) })
      void monaco
    }
  })

  onBeforeUnmount(disposeEditor)

  return { disposeEditor }
}
