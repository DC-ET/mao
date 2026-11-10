import { describe, expect, it, vi } from 'vitest'
import {
  ANNOTATE_COLOR,
  ANNOTATE_LINE_WIDTH,
  applyMosaic,
  drawOp,
  fitImageSize,
  redrawOps,
  type AnnotateOp,
} from './image-annotate'

/** 记录调用的 2D context stub：仓库无 canvas 测试先例（jsdom getContext 返回 null），
 *  drawOp/applyMosaic 的断言全部走方法序列与参数（方案 §7 测试策略）。 */
function makeCtx(options: { imageData?: (x: number, y: number, w: number, h: number) => number[] } = {}) {
  return {
    canvas: { width: 100, height: 80 },
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 0,
    lineJoin: '',
    lineCap: '',
    font: '',
    textBaseline: '',
    beginPath: vi.fn(),
    closePath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    fill: vi.fn(),
    clearRect: vi.fn(),
    getImageData: vi.fn((x: number, y: number, w: number, h: number) => {
      if (options.imageData) return { data: options.imageData(x, y, w, h) }
      return { data: new Uint8ClampedArray(w * h * 4) }
    }),
  } as unknown as CanvasRenderingContext2D & Record<string, ReturnType<typeof vi.fn> & { canvas: { width: number; height: number } }>
}

const penOp: AnnotateOp = {
  tool: 'pen', color: ANNOTATE_COLOR, width: ANNOTATE_LINE_WIDTH,
  points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }],
}

describe('drawOp', () => {
  it('pen：moveTo 首点 + 逐点 lineTo + stroke 一次，颜色线宽生效', () => {
    const ctx = makeCtx()
    drawOp(ctx, penOp)
    expect(ctx.strokeStyle).toBe(ANNOTATE_COLOR)
    expect(ctx.lineWidth).toBe(ANNOTATE_LINE_WIDTH)
    expect(ctx.beginPath).toHaveBeenCalledTimes(1)
    expect(ctx.moveTo).toHaveBeenCalledWith(1, 2)
    expect(ctx.lineTo).toHaveBeenCalledWith(3, 4)
    expect(ctx.lineTo).toHaveBeenCalledWith(5, 6)
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('pen 单点不成线（<2 点直接返回，无 stroke）', () => {
    const ctx = makeCtx()
    drawOp(ctx, { ...penOp, points: [{ x: 1, y: 1 }] })
    expect(ctx.stroke).not.toHaveBeenCalled()
  })

  it('rect：坐标归一化（min/宽高取绝对差）', () => {
    const ctx = makeCtx()
    drawOp(ctx, { tool: 'rect', color: ANNOTATE_COLOR, width: 3, x0: 10, y0: 20, x1: 4, y1: 8 })
    expect(ctx.strokeRect).toHaveBeenCalledWith(4, 8, 6, 12)
  })

  it('arrow：线体 + 实心三角头（fillStyle = 标注色）', () => {
    const ctx = makeCtx()
    drawOp(ctx, { tool: 'arrow', color: ANNOTATE_COLOR, width: 3, x0: 0, y0: 0, x1: 30, y1: 0 })
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(ctx.fill).toHaveBeenCalledTimes(1)
    expect(ctx.fillStyle).toBe(ANNOTATE_COLOR)
    // 三角尖落在线终点
    expect(ctx.moveTo).toHaveBeenCalledWith(30, 0)
  })

  it('text：16px sans-serif、baseline=top、fillText 于落笔点', () => {
    const ctx = makeCtx()
    drawOp(ctx, { tool: 'text', color: ANNOTATE_COLOR, width: 3, x: 12, y: 34, text: '重点', fontSize: 16 })
    expect(ctx.font).toContain('16px')
    expect(ctx.textBaseline).toBe('top')
    expect(ctx.fillText).toHaveBeenCalledWith('重点', 12, 34)
  })

  it('空 text 不落笔', () => {
    const ctx = makeCtx()
    drawOp(ctx, { tool: 'text', color: ANNOTATE_COLOR, width: 3, x: 1, y: 1, text: '' })
    expect(ctx.fillText).not.toHaveBeenCalled()
  })
})

describe('applyMosaic', () => {
  it('块均值填充：alpha>10 像素参与、透明像素忽略，fillRect 覆盖方块区域', () => {
    // 2×2 采样块：3 个红像素 + 1 个全透明 → 均值 (255,0,0)
    const ctx = makeCtx({
      imageData: () => [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0],
    })
    const baseCtx = makeCtx({ imageData: () => [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 0, 0] })
    applyMosaic(baseCtx, ctx, { tool: 'mosaic', color: ANNOTATE_COLOR, width: 3, points: [{ x: 15, y: 15 }], radius: 10 })
    expect(baseCtx.getImageData).toHaveBeenCalledWith(5, 5, 20, 20)
    expect(ctx.fillStyle).toBe('rgb(255,0,0)')
    expect(ctx.fillRect).toHaveBeenCalledWith(5, 5, 20, 20)
  })

  it('getImageData 抛 SecurityError → 降级灰色方块（防御性，taint 理论上不发生）', () => {
    const ctx = makeCtx()
    const baseCtx = makeCtx({
      imageData: () => { throw new Error('SecurityError') },
    })
    applyMosaic(baseCtx, ctx, { tool: 'mosaic', color: ANNOTATE_COLOR, width: 3, points: [{ x: 15, y: 15 }], radius: 10 })
    expect(ctx.fillStyle).toBe('rgba(127,127,127,0.85)')
    expect(ctx.fillRect).toHaveBeenCalled()
  })

  it('多点笔迹逐点取块', () => {
    const ctx = makeCtx()
    const baseCtx = makeCtx({ imageData: () => [10, 20, 30, 255] })
    applyMosaic(baseCtx, ctx, { tool: 'mosaic', color: ANNOTATE_COLOR, width: 3, points: [{ x: 5, y: 5 }, { x: 25, y: 5 }], radius: 10 })
    expect(baseCtx.getImageData).toHaveBeenCalledTimes(2)
    expect(ctx.fillRect).toHaveBeenCalledTimes(2)
  })
})

describe('redrawOps（撤销的重放原语）', () => {
  it('clearRect 后按序重放；mosaic 走 applyMosaic、其余走 drawOp', () => {
    const ctx = makeCtx()
    const baseCtx = makeCtx({ imageData: () => [10, 20, 30, 255] })
    const ops: AnnotateOp[] = [
      { tool: 'pen', color: ANNOTATE_COLOR, width: 3, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      { tool: 'mosaic', color: ANNOTATE_COLOR, width: 3, points: [{ x: 5, y: 5 }], radius: 10 },
      { tool: 'rect', color: ANNOTATE_COLOR, width: 3, x0: 1, y0: 1, x1: 9, y1: 9 },
    ]
    redrawOps(baseCtx, ctx, ops)
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 100, 80)
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
    expect(baseCtx.getImageData).toHaveBeenCalledTimes(1)
    expect(ctx.strokeRect).toHaveBeenCalledTimes(1)
  })

  it('undo 等价性：同 ctx 清层重放与全新重放的绘制序列逐条一致（不依赖前缀状态）', () => {
    const opsAll: AnnotateOp[] = [
      { tool: 'pen', color: ANNOTATE_COLOR, width: 3, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      { tool: 'mosaic', color: ANNOTATE_COLOR, width: 3, points: [{ x: 5, y: 5 }], radius: 10 },
      { tool: 'rect', color: ANNOTATE_COLOR, width: 3, x0: 1, y0: 1, x1: 9, y1: 9 },
    ]
    const a = makeCtx()
    const aBase = makeCtx({ imageData: () => [10, 20, 30, 255] })
    redrawOps(aBase, a, opsAll)
    const popped = opsAll.slice(0, -1)
    // 模拟撤销：同一 ctx 上清层重放前 N-1 条（mock 先清历史，只比较本次重放的调用）
    for (const c of [a, aBase]) {
      for (const value of Object.values(c)) {
        if (typeof value === 'function' && 'mockClear' in value) (value as ReturnType<typeof vi.fn>).mockClear()
      }
    }
    redrawOps(aBase, a, popped)
    const b = makeCtx()
    const bBase = makeCtx({ imageData: () => [10, 20, 30, 255] })
    redrawOps(bBase, b, popped)
    const keys = ['beginPath', 'moveTo', 'lineTo', 'stroke', 'strokeRect', 'fillRect', 'fillText']
    for (const key of keys) {
      expect((a[key] as ReturnType<typeof vi.fn>).mock.calls).toEqual((b[key] as ReturnType<typeof vi.fn>).mock.calls)
    }
  })
})

describe('fitImageSize', () => {
  it('小图原样保留', () => {
    expect(fitImageSize(100, 50)).toEqual({ width: 100, height: 50 })
  })

  it('超过 4096 等比缩放（取长边）', () => {
    expect(fitImageSize(8192, 4096)).toEqual({ width: 4096, height: 2048 })
    expect(fitImageSize(5000, 1000)).toEqual({ width: 4096, height: 819 })
  })

  it('零尺寸兜底为 1px', () => {
    expect(fitImageSize(0, 0)).toEqual({ width: 1, height: 1 })
  })
})
