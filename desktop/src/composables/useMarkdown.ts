import { Marked } from 'marked'
import { colorizeCode } from '../utils/monaco-colorize'
import { monacoLangFromFence } from '../utils/monaco-lang'
import { isExternalMarkdownLink } from '../utils/markdown-link'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function encodeCodeForCopy(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

const COPY_CODE_ONCLICK = "navigator.clipboard.writeText(decodeURIComponent(escape(atob(this.closest('.code-block').dataset.code || ''))))"

function createMarked(isDark: boolean): Marked {
  const marked = new Marked({ breaks: false })
  marked.use({
    async: true,
    async walkTokens(token) {
      if (token.type !== 'code') return
      const rawCode = token.text
      const language = monacoLangFromFence(token.lang)
      const highlighted = await colorizeCode(rawCode, language, isDark)
      token.escaped = true
      token.text = `<pre class="code-block" data-code="${encodeCodeForCopy(rawCode)}"><div class="code-block-header"><span class="code-lang">${escapeHtml(language)}</span><button class="code-copy-btn" onclick="${COPY_CODE_ONCLICK}">复制</button></div>${highlighted}</pre>`
    },
    renderer: {
      code({ text }) {
        return text
      },
      link({ href, text }) {
        if (isExternalMarkdownLink(href)) {
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`
        }
        return `<a href="${escapeHtml(href)}">${text}</a>`
      },
    },
  })
  return marked
}

export async function renderMarkdown(
  text: string,
  isDark = document.documentElement.getAttribute('data-theme') === 'dark',
): Promise<string> {
  if (!text) return ''
  const result = await createMarked(isDark).parse(text)
  if (typeof result === 'string') return result
  return text
}

export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  const result = new Marked({ breaks: false }).parseInline(text)
  if (typeof result === 'string') return result
  return text
}
