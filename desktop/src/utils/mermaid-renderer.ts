/**
 * Mermaid 图渲染调度（技术方案 docs/plan/2026-10-25-message-rendering-technical-design.md §5.2）。
 *
 * marked 层产出占位（data-mermaid = base64 源码，初始内容为可复制的原代码块），本模块在
 * MarkdownContent 的 v-html 落盘后完成渲染与原位替换：
 * - SVG 只在这里生成，绝不进 renderMarkdown 的消毒前字符串（设计红线 B2，主链
 *   SANITIZE_OPTIONS 不改）；
 * - 串行队列 + SVG 缓存（写入序淘汰）：流式整串重渲后的重插是缓存回填 O(1)（C1）；
 * - 任务执行前/后校验 isConnected 与源码未变，过期占位（已被重渲换掉）直接丢弃（C4）；
 * - 渲染 / 加载失败一律保留占位内的原代码块形态，无 UI 噪音。
 */
import DOMPurify from 'dompurify'
import { decodeBase64Utf8, encodeBase64Utf8 } from './base64'
import { themeName } from './monaco-loader'

const MERMAID_LANGS = new Set(['mermaid', 'mmd'])

/** 占位源码上限：超过则不渲染、保持普通代码块（F2：base64 属性体积与渲染成本兜底）。 */
export const MERMAID_SOURCE_CAP = 64 * 1024

export function isMermaidFence(lang: string | null | undefined): boolean {
  if (!lang) return false
  return MERMAID_LANGS.has(lang.toLowerCase().trim())
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 构造占位节点：初始内容即完整原代码块（复制按钮可用，渲染失败时的天然降级基底），
 * 渲染成功后替换为「图 + 查看源码折叠（内嵌原代码块）」。code 挂 monaco-code 与主题类，
 * 与 colorizeCode 产物同构——底色 / 内边距样式挂在 .monaco-code 上（评审 R1-2）。
 */
export function buildMermaidPlaceholder(source: string, isDark: boolean): string {
  const encoded = encodeBase64Utf8(source)
  const escaped = escapeHtml(source)
  // 复用 monaco-loader 的主题名，避免 aw-light/aw-dark 字面量漂移（评审 N2）
  const theme = themeName(isDark)
  return (
    `<div class="mermaid-block" data-mermaid="${encoded}">` +
    '<pre class="code-block" data-code="' + encoded + '">' +
    '<div class="code-block-header"><span class="code-lang">mermaid</span><button class="code-copy-btn" type="button">复制</button></div>' +
    `<code class="monaco-code ${theme}">${escaped}</code>` +
    '</pre>' +
    '</div>'
  )
}

/** 写入序淘汰缓存：超上限淘汰最旧写入项（与 useMarkdown 的 MARKED_CACHE_MAX 同范式）。 */
export class InsertionOrderCache<V> {
  private map = new Map<string, V>()
  private readonly max: number

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max))
  }

  get(key: string): V | undefined {
    return this.map.get(key)
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  get size(): number {
    return this.map.size
  }
}

type MermaidModule = (typeof import('mermaid'))['default']

const SVG_CACHE_MAX = 100
const svgCache = new InsertionOrderCache<string>(SVG_CACHE_MAX)
let renderSeq = 0
let queueTail: Promise<void> = Promise.resolve()
let mermaidPromise: Promise<MermaidModule> | null = null

/** SVG 专用消毒配置：仅本次调用生效，与 renderMarkdown 主链 SANITIZE_OPTIONS 互不影响（B3/B5）。 */
export const SVG_SANITIZE_OPTIONS = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // mermaid 把主题样式内嵌进 <style>，剥掉图会失去布局；DOMPurify 对其内容自带过滤
  ADD_TAGS: ['style'],
  // F1：htmlLabels 已在 config 关闭，foreignObject / script 在此兜底禁止
  FORBID_TAGS: ['foreignObject', 'script'],
  ADD_ATTR: ['xmlns'],
}

// 与 style.css --aw-font-text 同族：mermaid 按 DOM 测量排版，字体不一致会导致布局错位（E2）
const MERMAID_FONT_FAMILY =
  "'SF Pro Text', system-ui, -apple-system, 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', sans-serif"

function mermaidConfig(isDark: boolean) {
  return {
    startOnLoad: false,
    securityLevel: 'strict' as const,
    theme: isDark ? ('dark' as const) : ('default' as const),
    flowchart: { htmlLabels: false },
    themeVariables: {
      background: 'transparent',
      fontFamily: MERMAID_FONT_FAMILY,
    },
  }
}

async function loadMermaid(): Promise<MermaidModule> {
  mermaidPromise ??= import('mermaid').then((m) => m.default)
  try {
    return await mermaidPromise
  } catch (err) {
    // 加载失败可重试（如瞬时断网），本次占位保持代码块形态
    mermaidPromise = null
    throw err
  }
}

/** 占位是否已过期：被 v-html 重建断链 / 已渲染过 / 源码已变（C4）。 */
function isStale(el: HTMLElement, source64: string): boolean {
  return !el.isConnected || el.classList.contains('mermaid-rendered') || el.dataset.mermaid !== source64
}

/**
 * 扫描 root 内未渲染的 mermaid 占位并排队渲染。
 * MarkdownContent 在每次 v-html 更新后（非流式）调用；同屏多实例共享同一串行队列（D1）。
 */
export function insertMermaidDiagrams(root: HTMLElement): void {
  const nodes = root.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid]:not(.mermaid-rendered)')
  nodes.forEach((el) => {
    const source64 = el.dataset.mermaid ?? ''
    queueTail = queueTail.then(() => renderOne(el, source64)).catch(() => {
      // 单图失败不阻塞队列；占位保持代码块形态
    })
  })
}

async function renderOne(el: HTMLElement, source64: string): Promise<void> {
  if (isStale(el, source64)) return
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark'
  const cacheKey = `${isDark ? 'dark' : 'light'}|${source64}`
  const cached = svgCache.get(cacheKey)
  if (cached != null) {
    fillRendered(el, cached)
    return
  }

  const source = decodeBase64Utf8(source64)
  if (source == null || !source.trim()) return
  const mermaid = await loadMermaid()
  if (isStale(el, source64)) return
  mermaid.initialize(mermaidConfig(isDark))
  const valid = await mermaid.parse(source, { suppressErrors: true })
  if (valid === false || isStale(el, source64)) return
  const { svg } = await mermaid.render(`mao-mermaid-${++renderSeq}`, source)
  if (isStale(el, source64)) return
  const safeSvg = DOMPurify.sanitize(svg, SVG_SANITIZE_OPTIONS)
  svgCache.set(cacheKey, safeSvg)
  fillRendered(el, safeSvg)
}

function fillRendered(el: HTMLElement, svg: string): void {
  const sourcePre = el.querySelector('pre.code-block')
  el.classList.add('mermaid-rendered')
  el.innerHTML = ''
  const figure = document.createElement('div')
  figure.className = 'mermaid-figure'
  figure.innerHTML = svg
  el.appendChild(figure)
  const details = document.createElement('details')
  details.className = 'mermaid-source'
  const summary = document.createElement('summary')
  summary.textContent = '查看源码'
  details.appendChild(summary)
  // 折叠内保留原代码块（含 data-code），复制按钮经 document 级委托继续可用（H2/决策 3）
  if (sourcePre) details.appendChild(sourcePre)
  el.appendChild(details)
  // 图替换改变高度：外层自动滚动依赖该事件重新测量（C5）
  window.dispatchEvent(new CustomEvent('mao:markdown-rendered'))
}
