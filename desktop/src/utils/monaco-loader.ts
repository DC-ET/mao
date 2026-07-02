import { ensureMonacoEnvironment } from './monaco-env'

type MonacoModule = typeof import('monaco-editor')

let monacoModule: MonacoModule | null = null
let themesDefined = false

export function themeName(isDark: boolean): string {
  return isDark ? 'aw-dark' : 'aw-light'
}

export function defineMonacoThemes(monaco: MonacoModule): void {
  if (themesDefined) return
  themesDefined = true

  monaco.editor.defineTheme('aw-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#f5f5f7',
      'editor.lineHighlightBackground': '#00000000',
      'editorGutter.background': '#f5f5f7',
    },
  })

  monaco.editor.defineTheme('aw-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1e1e28',
      'editor.lineHighlightBackground': '#00000000',
      'editorGutter.background': '#1e1e28',
    },
  })
}

export async function loadMonaco(): Promise<MonacoModule> {
  if (monacoModule) return monacoModule
  ensureMonacoEnvironment()
  monacoModule = await import('monaco-editor')
  defineMonacoThemes(monacoModule)
  return monacoModule
}

export async function applyMonacoTheme(isDark: boolean): Promise<void> {
  const monaco = await loadMonaco()
  monaco.editor.setTheme(themeName(isDark))
}
