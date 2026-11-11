/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import { describe, expect, it, vi } from 'vitest'

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
  const app = createApp({
    render: () => h(MarkdownContent, {
      content: options.content,
      streaming: streaming.value,
      codeBlockEnhance: options.codeBlockEnhance ?? false,
    }),
  })
  app.use(ElementPlus)
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    streaming,
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

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
