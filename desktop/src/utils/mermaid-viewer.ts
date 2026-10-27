/**
 * Mermaid 图全屏查看器。
 *
 * 聊天气泡里的图被 `.mermaid-figure svg { max-width:100% }` 强制缩到容器宽，宽架构图
 * （viewBox 数千 px）会把 mermaid 的 16px 基准字号压到 4~5px，读不了——而 `overflow-x:auto`
 * 因 SVG 永远不大于容器从未生效，等于没有缩放入口。点图进这里按原始尺寸看。
 * 与 mermaid-renderer 同属 DOM 后处理层，不经过 Vue 挂载；SVG 字符串由调用方传入
 * （已是 DOMPurify 消毒产物），查看器只做「换 id + 设定尺寸」两类纯变换。
 */

export type MermaidViewerMode = 'fit' | 'native'

let overlay: HTMLElement | null = null
let stageEl: HTMLElement | null = null
let canvasEl: HTMLElement | null = null
let sizeHintEl: HTMLElement | null = null
let modeButtons: Partial<Record<MermaidViewerMode, HTMLButtonElement>> = {}
let activeSvg: SVGSVGElement | null = null
let naturalW = 0
let naturalH = 0
let mode: MermaidViewerMode = 'fit'
/** 查看器与气泡里的图同屏共存，复刻份的根 id 序号，保证文档内 id 不重复。 */
let cloneSeq = 0

/** mermaid 的 width 属性是 100%，真实尺寸在 viewBox；退化时读内联 max-width / max-height。 */
export function readNaturalSize(svg: string): { w: number; h: number } {
  const vb = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg)
  if (vb) return { w: Number(vb[3]), h: Number(vb[4]) }
  const mw = /max-width:\s*([\d.]+)px/.exec(svg)
  const mh = /max-height:\s*([\d.]+)px/.exec(svg)
  return { w: mw ? Number(mw[1]) : 0, h: mh ? Number(mh[1]) : 0 }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 复刻一份供查看器用：根 id 连同 `<style>` 里的 `#id` 选择器一起换掉，否则文档出现
 * 重复 id。只动 id 属性与 CSS 选择器两处，不碰标签文本——选择器用前视断言卡住边界，
 * 避免把 `#id-xxx` 这类内部元素 id 也改掉。
 */
export function cloneSvgForViewer(svg: string): string {
  const id = /<svg[^>]*\bid="([^"]+)"/.exec(svg)?.[1]
  if (!id) return svg
  const next = `mao-mermaid-view-${++cloneSeq}`
  const escaped = escapeRe(id)
  return svg
    .replace(new RegExp(`id="${escaped}"`, 'g'), `id="${next}"`)
    .replace(new RegExp(`#${escaped}(?=[\\s{,.:>)])`, 'g'), `#${next}`)
}

function applyMode(): void {
  if (!activeSvg || !stageEl) return
  // 显式写死宽高：mermaid 自带 width="100%" 与内联 max-width，只改 CSS 会被内联样式压过
  activeSvg.style.maxWidth = 'none'
  if (mode === 'fit' && naturalW > 0) {
    // 适配宽度只缩不放：图本就窄于舞台时按原始尺寸居中，硬拉宽会把小图充气
    const w = Math.min(naturalW, Math.max(160, stageEl.clientWidth - 32))
    const h = naturalH > 0 ? Math.round((w * naturalH) / naturalW) : 0
    activeSvg.style.width = `${w}px`
    activeSvg.style.height = h > 0 ? `${h}px` : 'auto'
    return
  }
  if (naturalW <= 0) {
    // 拿不到自然宽高，退回按舞台宽铺满
    activeSvg.style.width = `${Math.max(160, stageEl.clientWidth - 32)}px`
    activeSvg.style.height = 'auto'
    return
  }
  activeSvg.style.width = `${naturalW}px`
  activeSvg.style.height = naturalH > 0 ? `${naturalH}px` : 'auto'
}

function syncModeButtons(): void {
  for (const [key, btn] of Object.entries(modeButtons)) {
    if (btn) btn.classList.toggle('is-active', key === mode)
  }
}

function setMode(next: MermaidViewerMode): void {
  mode = next
  syncModeButtons()
  applyMode()
}

function closeViewer(): void {
  if (!overlay) return
  overlay.classList.remove('is-open')
  if (canvasEl) canvasEl.innerHTML = ''
  activeSvg = null
  document.removeEventListener('keydown', onViewerKeyDown)
}

function onViewerKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeViewer()
}

function buildOverlay(): void {
  overlay = document.createElement('div')
  overlay.className = 'mermaid-viewer'

  const backdrop = document.createElement('div')
  backdrop.className = 'mermaid-viewer-backdrop'
  backdrop.addEventListener('click', closeViewer)
  overlay.appendChild(backdrop)

  const panel = document.createElement('div')
  panel.className = 'mermaid-viewer-panel'
  panel.addEventListener('click', (event) => event.stopPropagation())

  const bar = document.createElement('div')
  bar.className = 'mermaid-viewer-bar'

  sizeHintEl = document.createElement('span')
  sizeHintEl.className = 'mermaid-viewer-title'
  bar.appendChild(sizeHintEl)

  const actions = document.createElement('div')
  actions.className = 'mermaid-viewer-actions'

  const modes: Array<{ key: MermaidViewerMode; label: string }> = [
    { key: 'fit', label: '适配宽度' },
    { key: 'native', label: '原始尺寸' },
  ]
  for (const { key, label } of modes) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mermaid-viewer-btn'
    btn.textContent = label
    btn.addEventListener('click', () => setMode(key))
    modeButtons[key] = btn
    actions.appendChild(btn)
  }

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'mermaid-viewer-btn mermaid-viewer-close'
  closeBtn.textContent = '关闭'
  closeBtn.addEventListener('click', closeViewer)
  actions.appendChild(closeBtn)

  bar.appendChild(actions)
  panel.appendChild(bar)

  stageEl = document.createElement('div')
  stageEl.className = 'mermaid-viewer-stage'
  canvasEl = document.createElement('div')
  canvasEl.className = 'mermaid-viewer-canvas'
  stageEl.appendChild(canvasEl)
  panel.appendChild(stageEl)

  overlay.appendChild(panel)
  document.body.appendChild(overlay)
}

/**
 * 打开全屏查看器。重复调用直接替换内容（同一时刻只有一个查看器实例）。
 * svg 必须是已消毒字符串——本模块不做任何净化，只做 id 与尺寸变换。
 */
export function openMermaidViewer(svg: string): void {
  if (!svg.trim()) return
  if (!overlay) buildOverlay()

  const size = readNaturalSize(svg)
  naturalW = size.w
  naturalH = size.h

  if (sizeHintEl) {
    sizeHintEl.textContent =
      naturalW > 0 ? `Mermaid 图 · ${Math.round(naturalW)} × ${Math.round(naturalH)}` : 'Mermaid 图'
  }

  // 默认原始尺寸：宽架构图在气泡里已被压到 4~5px，进查看器是为读字，
  // 「适配宽度」在等宽舞台下仍只有 6px 左右，作为默认模式没有意义。
  // 图本就窄于舞台时两种模式结果一致，不存在默认模式选错的问题。
  mode = 'native'
  syncModeButtons()
  if (canvasEl) canvasEl.innerHTML = cloneSvgForViewer(svg)
  activeSvg = canvasEl?.querySelector('svg') ?? null
  overlay?.classList.add('is-open')
  applyMode()
  // 尺寸依赖 stage 的实际宽度，首帧先按 fit 量一次再交给用户切换
  requestAnimationFrame(() => applyMode())
  document.addEventListener('keydown', onViewerKeyDown)
}
