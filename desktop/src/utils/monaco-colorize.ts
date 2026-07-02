import { loadMonaco, themeName } from './monaco-loader'
import { monacoLangFromFence } from './monaco-lang'

export async function colorizeCode(text: string, lang: string | undefined, isDark: boolean): Promise<string> {
  const monaco = await loadMonaco()
  monaco.editor.setTheme(themeName(isDark))

  const languageId = monacoLangFromFence(lang)
  const resolved = resolveLanguageId(monaco, languageId)
  const html = await monaco.editor.colorize(text, resolved, { tabSize: 2 })
  return `<code class="monaco-code ${themeName(isDark)}">${html}</code>`
}

function resolveLanguageId(monaco: typeof import('monaco-editor'), languageId: string): string {
  if (monaco.languages.getLanguages().some(lang => lang.id === languageId)) {
    return languageId
  }
  return 'plaintext'
}
