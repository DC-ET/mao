import { Marked } from 'marked'
import DOMPurify from 'dompurify'
import { colorizeCode } from '../utils/monaco-colorize'
import { monacoLangFromFence } from '../utils/monaco-lang'
import { isExternalMarkdownLink } from '../utils/markdown-link'
import { ensureCodeCopyDelegation } from '../utils/codeCopy'
import { ensureExternalLinkDelegation } from '../utils/externalLink'

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
      token.text = `<pre class="code-block" data-code="${encodeCodeForCopy(rawCode)}"><div class="code-block-header"><span class="code-lang">${escapeHtml(language)}</span><button class="code-copy-btn" type="button">复制</button></div>${highlighted}</pre>`
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

// 复制按钮走事件委托（utils/codeCopy），sanitize 保持默认严格白名单，不放行事件属性
const SANITIZE_OPTIONS = { ADD_ATTR: ['target'] }

// Marked 实例按主题复用：实例只持有配置（renderer/walkTokens），parse 状态是每次调用独立的；
// 流式期间每个气泡每次内容变化都渲染一次，新建实例是纯浪费
const markedCache = new Map<boolean, Marked>()
let inlineMarked: Marked | null = null

function getMarked(isDark: boolean): Marked {
  let instance = markedCache.get(isDark)
  if (!instance) {
    instance = createMarked(isDark)
    markedCache.set(isDark, instance)
  }
  return instance
}

export async function renderMarkdown(
  text: string,
  isDark = document.documentElement.getAttribute('data-theme') === 'dark',
): Promise<string> {
  if (!text) return ''
  ensureCodeCopyDelegation()
  ensureExternalLinkDelegation()
  const result = await getMarked(isDark).parse(text)
  if (typeof result !== 'string') return escapeHtml(text)
  // 统一消毒：防御各 renderer 之外的残留注入面
  return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
}

export function renderInlineMarkdown(text: string): string {
  if (!text) return ''
  ensureCodeCopyDelegation()
  ensureExternalLinkDelegation()
  inlineMarked ??= new Marked({ breaks: false })
  const result = inlineMarked.parseInline(text)
  if (typeof result !== 'string') return escapeHtml(text)
  return DOMPurify.sanitize(result, SANITIZE_OPTIONS)
}
