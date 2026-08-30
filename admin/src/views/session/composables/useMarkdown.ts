import { Marked } from 'marked'
import hljs from 'highlight.js'
import DOMPurify from 'dompurify'
import 'highlight.js/styles/github-dark.css'

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
      return `<pre class="code-block"><div class="code-block-header"><span class="code-lang">${language}</span><button class="code-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">复制</button></div><code class="hljs language-${language}">${highlighted}</code></pre>`
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
  const result = marked.parse(text)
  if (typeof result !== 'string') return escapeHtml(text)
  // 统一消毒：防御各 renderer 之外的残留注入面（onclick 为代码块复制按钮自带，内容侧已全部转义）
  return DOMPurify.sanitize(result, { ADD_ATTR: ['onclick', 'target'] })
}
