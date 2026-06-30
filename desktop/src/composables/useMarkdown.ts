import { Marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import { isExternalMarkdownLink } from '../utils/markdown-link'

const marked = new Marked({
  breaks: false,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      return `<pre class="code-block"><div class="code-block-header"><span class="code-lang">${language}</span><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">复制</button></div><code class="hljs language-${language}">${highlighted}</code></pre>`
    },
    link({ href, text }: { href: string; text: string }) {
      if (isExternalMarkdownLink(href)) {
        return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      }
      return `<a href="${href}">${text}</a>`
    }
  }
})

export function renderMarkdown(text: string): string {
  if (!text) return ''
  const result = marked.parse(text)
  // marked.parse returns string | Promise<string>, but with sync config it returns string
  if (typeof result === 'string') return result
  return text
}

export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  // Use marked inline lexer for single-line rendering without block elements
  const result = marked.parseInline(text)
  if (typeof result === 'string') return result
  return text
}
