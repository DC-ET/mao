/**
 * 图片轻标注纯函数（技术方案 docs/plan/2026-11/2026-11-10-rich-paste-annotate-technical-design.md §4.4）。
 *
 * 操作栈重放模型：ops 逐条重放到标注层 canvas，底层原图 canvas 只读不写——撤销 = 栈弹出 +
 * 清层重放，零原图损伤；导出 = 底图 + 标注层合并为 PNG。马赛克从底图 getImageData 取块均值
 * 填充到标注层（同源 objectURL 无 taint 风险，防御性 try/catch 见函数内）。
 * 全部不依赖对话框组件，ctx 可用 stub 单测（仓库无 canvas 测试先例，jsdom getContext 返回 null）。
 */

export const ANNOTATE_COLOR = '#e5484d'
export const ANNOTATE_LINE_WIDTH = 3
export const MOSAIC_DEFAULT_RADIUS = 10
export const ANNOTATE_FONT_SIZE = 16
/** 图片导入尺寸上限：任一边超过则等比缩放（与常见上传上限一致）。 */
export const MAX_ANNOTATE_EDGE = 4096

export type AnnotateTool = 'pen' | 'rect' | 'arrow' | 'text' | 'mosaic'

export interface AnnotateOp {
  tool: AnnotateTool
  color: string
  width: number
  /** pen / mosaic：笔迹点序列 */
  points?: Array<{ x: number; y: number }>
  /** rect / arrow：起止点 */
  x0?: number
  y0?: number
  x1?: number
  y1?: number
  /** text：落笔位置（左上角）与文本 */
  x?: number
  y?: number
  text?: string
  fontSize?: number
  /** mosaic：笔刷半径（px，方块边长之半） */
  radius?: number
}

/** 导入尺寸适配：小图原样、大图等比压到上限内（最少 1px）。 */
export function fitImageSize(width: number, height: number, maxEdge = MAX_ANNOTATE_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= 0) return { width: 1, height: 1 }
  const scale = Math.min(1, maxEdge / longest)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 显示尺寸：整图收进视口，保持比例，且不放大（小图维持 1:1，避免发糊）。
 * 画布位图仍用 fitImageSize 的结果，这里只决定 CSS 盒子。
 */
export function fitDisplaySize(
  imageWidth: number,
  imageHeight: number,
  availWidth: number,
  availHeight: number,
): { width: number; height: number } {
  if (imageWidth <= 0 || imageHeight <= 0) return { width: 1, height: 1 }
  const aw = Math.max(1, Math.floor(availWidth))
  const ah = Math.max(1, Math.floor(availHeight))
  const scale = Math.min(aw / imageWidth, ah / imageHeight, 1)
  return {
    width: Math.max(1, Math.min(aw, Math.round(imageWidth * scale))),
    height: Math.max(1, Math.min(ah, Math.round(imageHeight * scale))),
  }
}

/**
 * 文字字号（位图像素）。屏幕上至少 base 像素：图被缩小显示时把字号放大，
 * 导出后再按同一比例缩回去，仍和输入框里看到的一样大。1:1 时就是 base。
 */
export function annotateTextFontSize(bitmapEdge: number, displayEdge: number, base = ANNOTATE_FONT_SIZE): number {
  if (bitmapEdge <= 0 || displayEdge <= 0) return base
  const scale = Math.min(1, displayEdge / bitmapEdge)
  return Math.max(base, Math.round(base / scale))
}

/**
 * 指针坐标从 CSS 显示盒子换算到位图像素。
 * 显示被缩小后，getBoundingClientRect 是屏幕尺寸，笔迹必须落在位图上，导出才和看到的一致。
 */
export function canvasPointFromClient(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  bitmap: { width: number; height: number },
): { x: number; y: number } {
  const bw = Math.max(1, bitmap.width)
  const bh = Math.max(1, bitmap.height)
  const sx = rect.width > 0 ? bw / rect.width : 1
  const sy = rect.height > 0 ? bh / rect.height : 1
  const x = Math.round((clientX - rect.left) * sx)
  const y = Math.round((clientY - rect.top) * sy)
  return {
    x: Math.min(bw - 1, Math.max(0, x)),
    y: Math.min(bh - 1, Math.max(0, y)),
  }
}

export function drawOp(ctx: CanvasRenderingContext2D, op: AnnotateOp): void {
  ctx.strokeStyle = op.color
  ctx.fillStyle = op.color
  ctx.lineWidth = op.width
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  switch (op.tool) {
    case 'pen': {
      const points = op.points ?? []
      if (points.length < 2) return
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
      ctx.stroke()
      return
    }
    case 'rect': {
      if (op.x0 == null || op.y0 == null || op.x1 == null || op.y1 == null) return
      ctx.strokeRect(
        Math.min(op.x0, op.x1),
        Math.min(op.y0, op.y1),
        Math.abs(op.x1 - op.x0),
        Math.abs(op.y1 - op.y0),
      )
      return
    }
    case 'arrow': {
      if (op.x0 == null || op.y0 == null || op.x1 == null || op.y1 == null) return
      const dx = op.x1 - op.x0
      const dy = op.y1 - op.y0
      const len = Math.hypot(dx, dy) || 1
      const ux = dx / len
      const uy = dy / len
      const head = Math.max(op.width * 3.5, 10)
      // 线体缩短到箭头根部，避免穿出三角
      ctx.beginPath()
      ctx.moveTo(op.x0, op.y0)
      ctx.lineTo(op.x1 - ux * head, op.y1 - uy * head)
      ctx.stroke()
      // 实心三角头
      const px = -uy
      const py = ux
      ctx.beginPath()
      ctx.moveTo(op.x1, op.y1)
      ctx.lineTo(op.x1 - ux * head + px * head / 2, op.y1 - uy * head + py * head / 2)
      ctx.lineTo(op.x1 - ux * head - px * head / 2, op.y1 - uy * head - py * head / 2)
      ctx.closePath()
      ctx.fill()
      return
    }
    case 'text': {
      if (!op.text) return
      ctx.font = `${op.fontSize ?? ANNOTATE_FONT_SIZE}px sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(op.text, op.x ?? 0, op.y ?? 0)
      return
    }
    default:
      return
  }
}

/**
 * 马赛克：对底图 (x±r, y±r) 方块取像素均值，填充到标注层。全透明像素不参与均值；
 * getImageData 异常（防御：理论上同源 objectURL 无 taint）降级为灰色方块。
 */
export function applyMosaic(baseCtx: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, op: AnnotateOp): void {
  const r = Math.max(1, Math.round(op.radius ?? MOSAIC_DEFAULT_RADIUS))
  for (const p of op.points ?? []) {
    const x0 = Math.max(0, Math.round(p.x - r))
    const y0 = Math.max(0, Math.round(p.y - r))
    const w = Math.round(r * 2)
    const h = Math.round(r * 2)
    let avg: { r: number; g: number; b: number } | null = null
    try {
      const data = baseCtx.getImageData(x0, y0, w, h).data
      let sumR = 0
      let sumG = 0
      let sumB = 0
      let count = 0
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 10) continue
        sumR += data[i]
        sumG += data[i + 1]
        sumB += data[i + 2]
        count += 1
      }
      avg = count > 0 ? { r: Math.round(sumR / count), g: Math.round(sumG / count), b: Math.round(sumB / count) } : null
    } catch {
      avg = null
    }
    if (avg) ctx.fillStyle = `rgb(${avg.r},${avg.g},${avg.b})`
    else ctx.fillStyle = 'rgba(127,127,127,0.85)'
    ctx.fillRect(x0, y0, w, h)
  }
}

/** 清空标注层并按序重放 ops（撤销的实现原语；mosaic 走 applyMosaic，其余走 drawOp）。 */
export function redrawOps(baseCtx: CanvasRenderingContext2D, ctx: CanvasRenderingContext2D, ops: AnnotateOp[]): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  for (const op of ops) {
    if (op.tool === 'mosaic') applyMosaic(baseCtx, ctx, op)
    else drawOp(ctx, op)
  }
}
