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

/** 超长代码块同步高亮会卡住打开详情；超过则只转义，仍可复制。 */
const HIGHLIGHT_CHAR_LIMIT = 8000
const cache = new Map<string, string>()
const CACHE_LIMIT = 40

function encodeCode(text: string): string {
  try {
    return btoa(unescape(encodeURIComponent(text)))
  } catch {
    return ''
  }
}

function codeBlock(language: string, text: string, innerHtml: string): string {
  return `<pre class="code-block" data-code="${encodeCode(text)}"><div class="code-block-header"><span class="code-lang">${language}</span><button class="code-copy-btn" type="button">复制</button></div><code class="hljs language-${language}">${innerHtml}</code></pre>`
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
      const inner = text.length > HIGHLIGHT_CHAR_LIMIT
        ? escapeHtml(text)
        : hljs.highlight(text, { language }).value
      return codeBlock(language, text, inner)
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
  const cached = cache.get(text)
  if (cached != null) return cached
  ensureCodeCopyDelegation()
  const result = marked.parse(text)
  const html = typeof result === 'string'
    ? DOMPurify.sanitize(result, { ADD_ATTR: ['target'] })
    : escapeHtml(text)
  // 复制按钮走事件委托（utils/codeCopy），sanitize 保持默认严格白名单，不放行事件属性
  if (text.length <= 20_000) {
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest != null) cache.delete(oldest)
    }
    cache.set(text, html)
  }
  return html
}
