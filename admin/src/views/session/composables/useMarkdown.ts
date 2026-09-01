import { Marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.css'
import { ensureCodeCopyDelegation } from '../../../utils/codeCopy'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 仅允许 http/https 链接，拦截 javascript: 等危险协议 */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

const marked = new Marked({
  breaks: false,
  renderer: {
    // 原始 HTML 一律转义为纯文本展示，禁止注入标签
    html({ text }: { text: string }) {
      return escapeHtml(text)
    },
    code({ text, lang }: { text: string; lang?: string }) {
      const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(text, { language }).value
      const encoded = btoa(unescape(encodeURIComponent(text)))
      return `<pre class="code-block" data-code="${encoded}"><div class="code-block-header"><span class="code-lang">${language}</span><button class="code-copy-btn" type="button">复制</button></div><code class="hljs language-${language}">${highlighted}</code></pre>`
    },
    link({ href, text }: { href: string; text: string }) {
      if (!isSafeHref(href)) {
        return escapeHtml(text)
      }
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
    }
  }
})

export function renderMarkdown(text: string): string {
  if (!text) return ''
  ensureCodeCopyDelegation()
  const result = marked.parse(text)
  if (typeof result !== 'string') return escapeHtml(text)
  // 复制按钮走事件委托（utils/codeCopy），sanitize 保持默认严格白名单，不放行事件属性
  return DOMPurify.sanitize(result, { ADD_ATTR: ['target'] })
}
