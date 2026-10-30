/**
 * Mermaid 图全屏查看器。
 *
 * 聊天气泡里的图被 `.mermaid-figure svg { max-width:100% }` 强制缩到容器宽，宽架构图
 * （viewBox 数千 px）会把 mermaid 的 16px 基准字号压到 4~5px，读不了——而 `overflow-x:auto`
 * 因 SVG 永远不大于容器从未生效，等于没有缩放入口。点图进这里按需缩放着看。
 *
 * 缩放用离散档位而非连续滑杆：档位可预期、点按即可到达，且 SVG 是矢量的，放大不失真。
 * 与 mermaid-renderer 同属 DOM 后处理层，不经过 Vue 挂载；SVG 字符串由调用方传入
 * （已是 DOMPurify 消毒产物），查看器只做「换 id + 设定尺寸」两类纯变换。
 */

export type MermaidViewerMode = 'fit' | 'custom'

/** 缩放档位。下探到 5% 保证 393px 窄屏也能把宽图缩到看全，上探到 400% 够读细枝末节。 */
export const ZOOM_LADDER = [0.05, 0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4]

/** 打开时的缩放下限：fit 低于它就意味着文字不足 12px，不如先保证可读、剩下靠滚动。 */
const MIN_OPEN_SCALE = 0.75

const EPSILON = 1e-6

/** 取当前缩放的上/下一档；已在两端返回 null（调用方据此禁用按钮）。 */
export function nextZoomScale(current: number, direction: 'in' | 'out'): number | null {
  if (direction === 'in') {
    const next = ZOOM_LADDER.find((s) => s > current + EPSILON)
    return next ?? null
  }
  const lower = [...ZOOM_LADDER].reverse().find((s) => s < current - EPSILON)
  return lower ?? null
}

let overlay: HTMLElement | null = null
let stageEl: HTMLElement | null = null
let canvasEl: HTMLElement | null = null
let sizeHintEl: HTMLElement | null = null
let zoomOutBtn: HTMLButtonElement | null = null
let zoomInBtn: HTMLButtonElement | null = null
let scaleBtn: HTMLButtonElement | null = null
let fitBtn: HTMLButtonElement | null = null
let activeSvg: SVGSVGElement | null = null
let naturalW = 0
let naturalH = 0
let mode: MermaidViewerMode = 'fit'
let customScale = 1
/** 查看器与气泡里的图同屏共存，复刻份的根 id 序号，保证文档内 id 不重复。 */
let cloneSeq = 0
let onKeyDown: ((event: KeyboardEvent) => void) | null = null
let onResize: (() => void) | null = null

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

/** 适应宽度：只缩不放，图本就窄于舞台时按原始尺寸居中，硬拉宽会把小图充气。 */
function fitScale(): number {
  if (!stageEl || naturalW <= 0) return 1
  const available = Math.max(160, stageEl.clientWidth - 32)
  return Math.min(1, available / naturalW)
}

function currentScale(): number {
  return mode === 'fit' ? fitScale() : customScale
}

function applyScale(): void {
  if (!activeSvg) return
  const scale = currentScale()
  // 显式写死宽高：mermaid 自带 width="100%" 与内联 max-width，只改 CSS 会被内联样式压过
  activeSvg.style.maxWidth = 'none'
  activeSvg.style.width = `${Math.round(naturalW * scale)}px`
  activeSvg.style.height = naturalH > 0 ? `${Math.round(naturalH * scale)}px` : 'auto'

  if (scaleBtn) {
    scaleBtn.textContent = `${Math.round(scale * 100)}%`
    scaleBtn.title = '回到 100%'
  }
  if (zoomInBtn) zoomInBtn.disabled = nextZoomScale(scale, 'in') === null
  if (zoomOutBtn) zoomOutBtn.disabled = nextZoomScale(scale, 'out') === null
  if (fitBtn) fitBtn.classList.toggle('is-active', mode === 'fit')
}

function zoom(direction: 'in' | 'out'): void {
  const next = nextZoomScale(currentScale(), direction)
  if (next === null) return
  mode = 'custom'
  customScale = next
  applyScale()
}

function setFit(): void {
  mode = 'fit'
  applyScale()
}

function resetScale(): void {
  mode = 'custom'
  customScale = 1
  applyScale()
}

function closeViewer(): void {
  if (!overlay) return
  overlay.classList.remove('is-open')
  if (canvasEl) canvasEl.innerHTML = ''
  activeSvg = null
  if (onKeyDown) document.removeEventListener('keydown', onKeyDown)
  if (onResize) window.removeEventListener('resize', onResize)
  onKeyDown = null
  onResize = null
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault()
  closeViewer()
}

function buildButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `mermaid-viewer-btn ${className}`
  btn.textContent = label
  btn.addEventListener('click', onClick)
  return btn
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
  // 点面板空白处不关闭，只有遮罩与关闭按钮关
  panel.addEventListener('click', (event) => event.stopPropagation())

  const bar = document.createElement('div')
  bar.className = 'mermaid-viewer-bar'

  sizeHintEl = document.createElement('span')
  sizeHintEl.className = 'mermaid-viewer-title'
  bar.appendChild(sizeHintEl)

  const actions = document.createElement('div')
  actions.className = 'mermaid-viewer-actions'

  zoomOutBtn = buildButton('－', 'mermaid-viewer-zoom', () => zoom('out'))
  zoomOutBtn.title = '缩小'
  zoomOutBtn.setAttribute('aria-label', '缩小')
  actions.appendChild(zoomOutBtn)

  scaleBtn = buildButton('100%', 'mermaid-viewer-scale', resetScale)
  actions.appendChild(scaleBtn)

  zoomInBtn = buildButton('＋', 'mermaid-viewer-zoom', () => zoom('in'))
  zoomInBtn.title = '放大'
  zoomInBtn.setAttribute('aria-label', '放大')
  actions.appendChild(zoomInBtn)

  fitBtn = buildButton('适应', 'mermaid-viewer-fit', setFit)
  fitBtn.title = '适应宽度'
  actions.appendChild(fitBtn)

  actions.appendChild(buildButton('关闭', 'mermaid-viewer-close', closeViewer))

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

  if (canvasEl) canvasEl.innerHTML = cloneSvgForViewer(svg)
  activeSvg = canvasEl?.querySelector('svg') ?? null

  // 先显示再量宽度（display:none 时 clientWidth 为 0）
  overlay?.classList.add('is-open')

  // 默认尽量看全；但 fit 若把文字压到 12px 以下（窄屏看宽图常见），
  // 退到 75% 先保证可读，看全靠「适应」按钮或缩小档位。
  if (naturalW > 0 && fitScale() < MIN_OPEN_SCALE) {
    mode = 'custom'
    customScale = MIN_OPEN_SCALE
  } else {
    mode = 'fit'
  }
  applyScale()

  onKeyDown = handleKeyDown
  document.addEventListener('keydown', onKeyDown)
  // fit 模式依赖舞台宽度，窗口缩放时重算
  onResize = () => {
    if (mode === 'fit') applyScale()
  }
  window.addEventListener('resize', onResize)
}
