/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { markZoomableImages, pickZoomImage, ZOOM_CLASS } from './markdownZoom'

function div(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

function imgOf(root: HTMLElement): HTMLImageElement {
  return root.querySelector('img') as HTMLImageElement
}

describe('markZoomableImages', () => {
  it('普通正文 img 加 ZOOM_CLASS', () => {
    const root = div('<p>前文</p><img src="/uploads/7/x.png" alt="截图"><p>后文</p>')
    markZoomableImages(root)
    expect(imgOf(root).classList.contains(ZOOM_CLASS)).toBe(true)
    root.remove()
  })

  it('a 内 img 不加（链接行为优先）', () => {
    const root = div('<a href="https://x.cn"><img src="/uploads/7/y.png"></a>')
    markZoomableImages(root)
    expect(imgOf(root).classList.contains(ZOOM_CLASS)).toBe(false)
    root.remove()
  })

  it('.code-block 与 pre 内 img 不加（mermaid 占位 / 代码原文）', () => {
    const root = div(
      '<pre class="code-block"><img src="/uploads/7/a.png"></pre><pre><img src="/uploads/7/b.png"></pre>',
    )
    markZoomableImages(root)
    const imgs = root.querySelectorAll('img')
    expect(imgs.length).toBe(2)
    for (const img of Array.from(imgs)) expect(img.classList.contains(ZOOM_CLASS)).toBe(false)
    root.remove()
  })

  it('data-no-zoom=true 逃生口不加', () => {
    const root = div('<img src="/uploads/7/z.png" data-no-zoom="true">')
    markZoomableImages(root)
    expect(imgOf(root).classList.contains(ZOOM_CLASS)).toBe(false)
    root.remove()
  })

  it('重复调用幂等', () => {
    const root = div('<img src="/uploads/7/x.png"><img src="/uploads/7/y.png">')
    markZoomableImages(root)
    markZoomableImages(root)
    const imgs = root.querySelectorAll('img')
    for (const img of Array.from(imgs)) {
      expect(img.classList.contains(ZOOM_CLASS)).toBe(true)
      expect(img.classList.length).toBe(1)
    }
    root.remove()
  })
})

describe('pickZoomImage', () => {
  it('已标记 img 的点击命中，返回该元素', () => {
    const root = div('<img src="/uploads/7/x.png">')
    markZoomableImages(root)
    const img = imgOf(root)
    expect(pickZoomImage(img)).toBe(img)
    root.remove()
  })

  it('未标记 img 返回 null（流式中 / 宿主外）', () => {
    const root = div('<img src="/uploads/7/x.png">')
    const img = imgOf(root)
    expect(pickZoomImage(img)).toBeNull()
    root.remove()
  })

  it('a 内已标记 img 双保险返回 null', () => {
    const root = div('<a href="https://x.cn"><img src="/uploads/7/y.png"></a>')
    const img = imgOf(root)
    img.classList.add(ZOOM_CLASS) // 模拟异常态：带类但在链接内
    expect(pickZoomImage(img)).toBeNull()
    root.remove()
  })

  it('非元素 target 返回 null', () => {
    expect(pickZoomImage(null)).toBeNull()
    expect(pickZoomImage(document.createTextNode('x'))).toBeNull()
  })

  it('img 后代元素（如 caption span）向上命中', () => {
    const root = div('<img src="/uploads/7/x.png">')
    markZoomableImages(root)
    const caption = document.createElement('span')
    imgOf(root).appendChild(caption)
    expect(pickZoomImage(caption)).toBe(imgOf(root))
    root.remove()
  })
})
