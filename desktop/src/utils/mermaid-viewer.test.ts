// mermaid-viewer 纯函数部分：自然尺寸读取、查看器复刻的 id 改写、缩放档位推进。
// 全屏遮罩 / 尺寸应用依赖真实浏览器（clientWidth、SVG 布局），不在 node 层测。
import { describe, expect, it } from 'vitest'
import { cloneSvgForViewer, nextZoomScale, readNaturalSize, ZOOM_LADDER } from './mermaid-viewer'

// 贴近 mermaid 真实产物：根带 id 与内联 max-width，<style> 里是 #id 选择器，
// 节点 id 形如 #id-flowchart-WSH-1（不能被动到）
const SVG = `<svg id="mao-mermaid-7" width="100%" xmlns="http://www.w3.org/2000/svg" class="flowchart" style="max-width: 3324.09375px;" viewBox="0 0 3324.09375 925"><style>#mao-mermaid-7{font-size:16px;fill:#333;}#mao-mermaid-7 .node rect{fill:#ECECFF;}#mao-mermaid-7 .cluster text{fill:#333;}</style><g class="root"><g class="node default" id="mao-mermaid-7-flowchart-WSH-1"><rect x="-130" y="-63" width="260" height="126"></rect></g></g></svg>`

describe('readNaturalSize', () => {
  it('从 viewBox 读自然尺寸（mermaid 的 width 属性是 100%，不能信）', () => {
    expect(readNaturalSize(SVG)).toEqual({ w: 3324.09375, h: 925 })
  })

  it('没有 viewBox 时退化到内联 max-width / max-height', () => {
    const svg = '<svg id="x" style="max-width: 800.5px; max-height: 400.25px;"></svg>'
    expect(readNaturalSize(svg)).toEqual({ w: 800.5, h: 400.25 })
  })

  it('两者都没有时返回 0（调用方据此禁用原始尺寸模式）', () => {
    expect(readNaturalSize('<svg id="x"></svg>')).toEqual({ w: 0, h: 0 })
  })
})

describe('cloneSvgForViewer', () => {
  it('根 id 与 style 里的 #id 选择器一起换成新 id', () => {
    const out = cloneSvgForViewer(SVG)
    // 新 id 唯一，且原 id 不再作为根 id / 选择器出现
    const newId = /<svg[^>]*\bid="([^"]+)"/.exec(out)![1]
    expect(newId).toMatch(/^mao-mermaid-view-\d+$/)
    expect(out).toContain(`id="${newId}"`)
    expect(out).toContain(`#${newId}{font-size:16px`)
    expect(out).toContain(`#${newId} .node rect`)
    expect(out).not.toContain('id="mao-mermaid-7"')
    expect(out).not.toContain('#mao-mermaid-7{')
  })

  it('内部元素 id（#id-xxx）与 style 内容不被改写', () => {
    const out = cloneSvgForViewer(SVG)
    // 内部节点 id 保持原样：它靠自身 id 被引用，改了就断样式
    expect(out).toContain('id="mao-mermaid-7-flowchart-WSH-1"')
    // style 里的颜色声明原样保留（只是选择器换了 id）
    expect(out).toContain('{font-size:16px;fill:#333;}')
    expect(out).toContain('.cluster text{fill:#333;}')
    // 图的内容结构不变
    expect(out).toContain('<rect x="-130" y="-63" width="260" height="126"></rect>')
  })

  it('连续调用产生不同 id（气泡里的图与查看器复刻份同屏不冲突）', () => {
    const a = cloneSvgForViewer(SVG)
    const b = cloneSvgForViewer(SVG)
    expect(a).not.toBe(b)
  })

  it('根 svg 没有 id 时原样返回', () => {
    const svg = '<svg viewBox="0 0 10 10"></svg>'
    expect(cloneSvgForViewer(svg)).toBe(svg)
  })
})

describe('nextZoomScale', () => {
  it('放大取严格更大的下一档', () => {
    expect(nextZoomScale(0.5, 'in')).toBe(0.67)
    expect(nextZoomScale(1, 'in')).toBe(1.5)
    expect(nextZoomScale(0.75, 'in')).toBe(1)
  })

  it('缩小取严格更小的上一档', () => {
    expect(nextZoomScale(0.5, 'out')).toBe(0.33)
    expect(nextZoomScale(1, 'out')).toBe(0.75)
    expect(nextZoomScale(0.67, 'out')).toBe(0.5)
  })

  it('档位两端返回 null（调用方据此禁用按钮）', () => {
    expect(nextZoomScale(4, 'in')).toBeNull()
    expect(nextZoomScale(0.05, 'out')).toBeNull()
  })

  it('fit 算出的非档位值也能正确落到相邻档', () => {
    // 393px 窄屏看 3324px 宽图，fit ≈ 0.099，不在档位表里
    expect(nextZoomScale(0.099, 'in')).toBe(0.1)
    expect(nextZoomScale(0.099, 'out')).toBe(0.05)
    // 桌面 fit ≈ 0.342
    expect(nextZoomScale(0.342, 'in')).toBe(0.5)
    expect(nextZoomScale(0.342, 'out')).toBe(0.33)
  })

  it('恰好落在档位上不重复返回自己', () => {
    for (const s of ZOOM_LADDER) {
      expect(nextZoomScale(s, 'in')).not.toBe(s)
      expect(nextZoomScale(s, 'out')).not.toBe(s)
    }
  })

  it('档位表严格递增', () => {
    for (let i = 1; i < ZOOM_LADDER.length; i++) {
      expect(ZOOM_LADDER[i]).toBeGreaterThan(ZOOM_LADDER[i - 1])
    }
  })
})
