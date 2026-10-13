import { Marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { colorizeCode } from '../utils/monaco-colorize'
import { monacoLangFromFence } from '../utils/monaco-lang'
import { isExternalMarkdownLink } from '../utils/markdown-link'
import { ensureCodeCopyDelegation } from '../utils/codeCopy'
import { ensureExternalLinkDelegation } from '../utils/externalLink'
import { renderCitationMarkers, stripCitationDefinitions } from '../utils/citationMarkers'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * marked 默认 text renderer 的实体感知转义：`&` 仅在不是实体一部分时转义。
 * 文本 renderer 必须用它而不是 escapeHtml——全量转义会把消息里已有的
 * `&amp;` / `&copy;` 二次转义成 `&amp;amp;` / `&amp;copy;`，用户看到字面量。
 */
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeText(text: string): string {
  return text.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (ch) => ESCAPE_MAP[ch])
}

function encodeCodeForCopy(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

/** 仅允许 http/https 链接，拦截 javascript: 等危险协议 */
function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href)
}

/**
 * 新建带全部自定义 renderer 的 Marked 实例。导出供测试直接用 marked 层断言
 * （桌面 vitest 为 node 环境，跑不了依赖 DOMPurify/window 的 renderMarkdown 全链路）。
 */
export function createMarked(isDark: boolean, citeMap?: Record<number, number>): Marked {
  const marked = new Marked({ breaks: false })
  // renderer 方法在 marked 内部以 Renderer 实例为 this 调用，parse 前 marked 会把
  // parser 挂到该实例上——默认 text / link renderer 就是这样调 this.parser.parseInline
  // 的（Marked 实例自身没有 parser.parseInline，调它会 TypeError）。
  function parseInline(this: unknown, tokens: unknown[]): string {
    const self = this as { parser?: { parseInline(t: unknown[]): string } }
    return self.parser!.parseInline(tokens)
  }
  marked.use({
    async: true,
    // parse 前剥掉模型混用脚注语法写的定义行（`[^n^]: 链接`）：不剥时标记会转成
    // 上标、后面跟着 `: 链接` 残句；与正文同段（无空行分隔）时 marked 不会把它当
    // 引用定义消费，只能在这里按行删。挂在 marked 管道里而不是 renderMarkdown 入口，
    // 是为了让 node 环境的 createMarked().parse() 测试能直接覆盖这条路径。
    // 已知取舍：代码围栏内讲解本标记语法的示例行同样会被删（标准脚注 `[^1]:` 不匹配，
    // 双重条件下误伤面仅剩「在代码块里演示 [^n^]: 链接」这一种，可接受）。
    hooks: {
      preprocess(source: string) {
        return stripCitationDefinitions(source)
      },
    },
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
      // 引用标记（回复引用溯源）：[^n^] → 可点击上标。带子 token 的 text（紧凑
      // 列表项等）走默认 parseInline 保住嵌套加粗/链接；叶子 text 先按 marked
      // 默认语义转义再替换标记，插入的只有固定结构的 sup（display 序号为数字），
      // 无注入面。code / codespan 不经 text renderer，代码块内的标记不受影响。
      // 参数用结构类型而非 Tokens.Text：marked 该方法的入参联合是 Escape | Text，
      // 标注 Tokens.Text 过不了 this/入参的兼容检查（Escape 没有 tokens / escaped）。
      text(token: { text?: string; tokens?: unknown[]; escaped?: boolean }) {
        if (token.tokens && token.tokens.length > 0) {
          return parseInline.call(this, token.tokens)
        }
        const raw = token.escaped ? (token.text ?? '') : escapeText(token.text ?? '')
        return renderCitationMarkers(raw, citeMap)
      },
      // 链接文本也走 parseInline：否则链接里的嵌套内容（含 [^n^] 标记）到不了
      // text renderer，标记会以原样泄漏在 <a> 里
      link(token: Tokens.Link) {
        const href = token.href ?? ''
        const inner = token.tokens && token.tokens.length > 0
          ? parseInline.call(this, token.tokens)
          : escapeHtml(token.text ?? '')
        if (!isSafeHref(href)) {
          return inner
        }
        if (isExternalMarkdownLink(href)) {
          return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        }
        return `<a href="${escapeHtml(href)}">${inner}</a>`
      },
    },
  })
  return marked
}

// 复制按钮走事件委托（utils/codeCopy），sanitize 保持默认严格白名单，不放行事件属性
const SANITIZE_OPTIONS = { ADD_ATTR: ['target'] }

// Marked 实例按「主题 + citeMap」复用：实例只持有配置（renderer/walkTokens），parse 状态是
// 每次调用独立的；流式期间每个气泡每次内容变化都渲染一次，新建实例是纯浪费。
// citeMap 进缓存键：同一条消息流式刷新期间映射不变，实例可命中。
const markedCache = new Map<string, Marked>()
let inlineMarked: Marked | null = null

function citeMapCacheKey(citeMap?: Record<number, number>): string {
  if (!citeMap) return ''
  return Object.keys(citeMap).sort((a, b) => Number(a) - Number(b)).map((n) => `${n}>${citeMap[Number(n)]}`).join(',')
}

/** citeMap 进缓存键后条目数随不同引用集增长，设上限防长会话无界膨胀（超限整体清空， miss 只是重建实例）。 */
const MARKED_CACHE_MAX = 32

function getMarked(isDark: boolean, citeMap?: Record<number, number>): Marked {
  const cacheKey = `${isDark ? 'dark' : 'light'}|${citeMapCacheKey(citeMap)}`
  let instance = markedCache.get(cacheKey)
  if (!instance) {
    if (markedCache.size >= MARKED_CACHE_MAX) markedCache.clear()
    instance = createMarked(isDark, citeMap)
    markedCache.set(cacheKey, instance)
  }
  return instance
}

export async function renderMarkdown(
  text: string,
  isDark = document.documentElement.getAttribute('data-theme') === 'dark',
  citeMap?: Record<number, number>,
): Promise<string> {
  if (!text) return ''
  ensureCodeCopyDelegation()
  ensureExternalLinkDelegation()
  const result = await getMarked(isDark, citeMap).parse(text)
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
