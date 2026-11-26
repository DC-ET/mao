/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { afterEach, describe, expect, it, vi } from 'vitest'

const renderControl = vi.hoisted(() => ({
  impl: null as null | ((text: string, isDark?: boolean, citeMap?: Record<number, number>) => Promise<string>),
}))

vi.mock('../../composables/useMarkdown', async () => {
  const actual = await vi.importActual<typeof import('../../composables/useMarkdown')>('../../composables/useMarkdown')
  return {
    ...actual,
    renderMarkdown: (text: string, isDark?: boolean, citeMap?: Record<number, number>) => {
      if (renderControl.impl) return renderControl.impl(text, isDark, citeMap)
      return actual.renderMarkdown(text, isDark, citeMap)
    },
  }
})

// MarkdownContent → renderMarkdown 依赖链：theme 读 window.matchMedia（jsdom 无实现）、
// monaco-colorize 会真加载 monaco-editor——两者都 mock（ToolCallCard.test.ts 同款）
vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: ref(false) }),
}))
vi.mock('../../utils/monaco-colorize', () => ({
  colorizeCode: vi.fn(async (text: string, lang: string, isDark: boolean) =>
    `<code class="monaco-code ${isDark ? 'vs-dark' : 'vs'}">${lang}:${text}</code>`),
}))

import MarkdownContent from './MarkdownContent.vue'

/** renderMarkdown 异步（含 Monaco mock 高亮），flush 后 DOM 才就绪 */
async function flush() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

interface MountOptions {
  content: string
  streaming?: boolean
  codeBlockEnhance?: boolean
}

function mount(options: MountOptions) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const streaming = ref(options.streaming ?? false)
  const content = ref(options.content)
  const app = createApp({
    render: () => h(MarkdownContent, {
      content: content.value,
      streaming: streaming.value,
      codeBlockEnhance: options.codeBlockEnhance ?? false,
    }),
  })
  app.use(ElementPlus)
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    streaming,
    content,
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

afterEach(() => {
  renderControl.impl = null
  vi.useRealTimers()
})

function bodyImg(): HTMLImageElement | null {
  return document.querySelector('.markdown-body img')
}

function viewer(): Element | null {
  return document.querySelector('.el-image-viewer__wrapper')
}

function clickImg(img: HTMLImageElement) {
  img.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

async function clickAndFlush(img: HTMLImageElement) {
  clickImg(img)
  await nextTick()
  await flush()
}

describe('MarkdownContent 单根宿主', () => {
  it('正文 class 在唯一根上，透传 class 落在同一节点，查看器不占兄弟根', async () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const app = createApp({
      render: () => h(MarkdownContent, {
        class: 'page-body',
        content: '段落\n\n| 甲 | 乙 |\n| --- | --- |\n| 1 | 2 |',
      }),
    })
    app.use(ElementPlus)
    app.config.warnHandler = () => {}
    app.mount(el)
    await flush()

    const host = el.firstElementChild as HTMLElement | null
    expect(host).toBeTruthy()
    expect(el.childElementCount).toBe(1)
    expect(host!.classList.contains('markdown-body')).toBe(true)
    expect(host!.classList.contains('page-body')).toBe(true)
    expect(host!.querySelector('table')).toBeTruthy()
    expect(host!.querySelector('p')).toBeTruthy()

    app.unmount()
    el.remove()
  })
})

describe('MarkdownContent 正文图片点击放大', () => {
  it('正文 img 渲染后带 md-img-zoom，点击弹出 viewer（teleported 挂 body），关闭后卸载', async () => {
    const mounted = mount({ content: '前文\n\n![截图](/uploads/7/x.png)\n\n后文' })
    await flush()

    const img = bodyImg()
    expect(img).toBeTruthy()
    expect(img!.getAttribute('src')).toBe('/uploads/7/x.png')
    expect(img!.classList.contains('md-img-zoom')).toBe(true)

    await clickAndFlush(img!)
    const wrapper = viewer()
    expect(wrapper).toBeTruthy()
    // teleported：viewer 必须挂在 body 顶层（默认 false 原地渲染会被裁剪，方案 §10-1 关键修正）
    expect(wrapper!.parentElement).toBe(document.body)

    // hide-on-click-modal：点遮罩即退出（element-plus 默认 false，方案验收口径）
    const mask = wrapper!.querySelector('.el-image-viewer__mask') as HTMLElement | null
    expect(mask).toBeTruthy()
    mask?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flush()
    expect(viewer()).toBeNull()

    // 重开后走关闭按钮退出
    await clickAndFlush(bodyImg()!)
    const reopened = viewer()
    expect(reopened).toBeTruthy()
    const closeBtn = reopened!.querySelector('.el-image-viewer__close') as HTMLButtonElement | null
    expect(closeBtn).toBeTruthy()
    closeBtn?.click()
    await flush()
    expect(viewer()).toBeNull()
    mounted.destroy()
  })

  it('a 包裹的图片不加类，点击走链接不弹 viewer', async () => {
    const mounted = mount({ content: '[![链接图](/uploads/7/y.png)](https://x.cn/a)' })
    await flush()

    const img = bodyImg()
    expect(img).toBeTruthy()
    expect(img!.classList.contains('md-img-zoom')).toBe(false)

    await clickAndFlush(img!)
    expect(viewer()).toBeNull()
    mounted.destroy()
  })

  it('streaming 时不标记不弹，翻转 false 后补标记可弹（C6 语义）', async () => {
    const mounted = mount({ content: '![进行中](/uploads/7/z.png)', streaming: true })
    await flush()

    let img = bodyImg()
    expect(img).toBeTruthy()
    expect(img!.classList.contains('md-img-zoom')).toBe(false)
    await clickAndFlush(img!)
    expect(viewer()).toBeNull()

    mounted.streaming.value = false
    await flush()
    img = bodyImg()
    expect(img!.classList.contains('md-img-zoom')).toBe(true)
    await clickAndFlush(img!)
    expect(viewer()).toBeTruthy()
    mounted.destroy()
  })
})

describe('MarkdownContent 慢渲染提示', () => {
  it('超过阈值仍未渲完时显示正在渲染，完成后消失', async () => {
    vi.useFakeTimers()
    let resolveRender: (html: string) => void = () => {}
    renderControl.impl = () => new Promise(resolve => { resolveRender = resolve })
    const mounted = mount({ content: '很长的最终回复' })
    await nextTick()
    expect(document.querySelector('.md-render-pending')).toBeNull()

    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
    expect(document.querySelector('.md-render-pending')?.textContent).toContain('正在渲染…')

    resolveRender('<p>很长的最终回复</p>')
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(document.querySelector('.md-render-pending')).toBeNull()
    expect(document.querySelector('.markdown-body')?.textContent).toContain('很长的最终回复')
    mounted.destroy()
  })

  it('短内容在阈值内渲完，不出现正在渲染', async () => {
    vi.useFakeTimers()
    const mounted = mount({ content: '短回复' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(document.body.textContent).toContain('短回复')

    await vi.advanceTimersByTimeAsync(500)
    await nextTick()
    expect(document.querySelector('.md-render-pending')).toBeNull()
    mounted.destroy()
  })

  it('流式输出不显示正在渲染', async () => {
    vi.useFakeTimers()
    renderControl.impl = () => new Promise(() => {})
    const mounted = mount({ content: '流式中的回复', streaming: true })
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    await nextTick()
    expect(document.querySelector('.md-render-pending')).toBeNull()
    mounted.destroy()
  })

  it('已有正文后再渲染，继续显示旧内容，不换成正在渲染', async () => {
    vi.useFakeTimers()
    const mounted = mount({ content: '第一版' })
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    expect(document.body.textContent).toContain('第一版')

    renderControl.impl = () => new Promise(() => {})
    mounted.content.value = '第二版很长'
    await nextTick()
    await vi.advanceTimersByTimeAsync(500)
    await nextTick()
    expect(document.querySelector('.md-render-pending')).toBeNull()
    expect(document.body.textContent).toContain('第一版')
    mounted.destroy()
  })
})
