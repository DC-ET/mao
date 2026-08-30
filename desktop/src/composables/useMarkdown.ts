import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { colorizeCode } from '../utils/monaco-colorize'
import { monacoLangFromFence } from '../utils/monaco-lang'
import { isExternalMarkdownLink } from '../utils/markdown-link'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function encodeCodeForCopy(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

const COPY_CODE_ONCLICK = `(()=>{var t=decodeURIComponent(escape(atob(this.closest('.code-block').dataset.code||'')));if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).catch(function(){copyFallback(t)})}else{copyFallback(t)}function copyFallback(s){var a=document.createElement('textarea');a.value=s;a.style.position='fixed';a.style.top='-9999px';a.style.opacity='0';document.body.appendChild(a);a.select();try{document.execCommand('copy')}catch(e){}document.body.removeChild(a)}})()`

/** 仅允许 http/https 链接，拦截 javascript: 等危险协议 */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

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
      // 原始 HTML 一律转义为纯文本展示，禁止注入标签
      html({ text }: { text: string }) {
        return escapeHtml(text)
      },
      code({ text }) {
        return text
      },
      link({ href, text }) {
        if (!isSafeHref(href)) {
          return escapeHtml(text)
        }
        if (isExternalMarkdownLink(href)) {
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`
        }
        return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`
      },
    },
  })
  return marked
}

// onclick 为代码块复制按钮自带，内容侧已全部转义
const SANITIZE_OPTIONS = { ADD_ATTR: ['onclick', 'target'] }

export async function renderMarkdown(
  text: string,
  isDark = document.documentElement.getAttribute('data-theme') === 'dark',
): Promise<string> {
  if (!text) return ''
  const result = await createMarked(isDark).parse(text)
  if (typeof result !== 'string') return escapeHtml(text)
  // 统一消毒：防御各 renderer 之外的残留注入面
  return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
}

export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  const result = new Marked({ breaks: false }).parseInline(text)
  if (typeof result !== 'string') return escapeHtml(text)
  return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
}
