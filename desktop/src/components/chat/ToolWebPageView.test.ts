/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// 与 ToolCallCard.test.ts 同因：ToolWebPageView → MarkdownContent → useMarkdown →
// monaco-colorize（真加载 monaco-editor）+ theme.ts（import 期读 window.matchMedia）
vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: ref(false) }),
}))
vi.mock('../../utils/monaco-colorize', () => ({
  colorizeCode: vi.fn(async (text: string) => `<code class="monaco-code">${text}</code>`),
}))

import ToolWebPageView from './ToolWebPageView.vue'

const flush = () => new Promise(r => setTimeout(r, 0))

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const opened: string[] = []
  const app = createApp({
    setup() {
      return () => h(ToolWebPageView, {
        url: '',
        title: '',
        content: '',
        truncated: false,
        fullFile: '',
        error: '',
        ...props,
        onOpenFile: (path: string) => opened.push(path),
      })
    },
  })
  app.config.warnHandler = () => {}
  app.mount(el)
  return { opened, destroy() { app.unmount(); el.remove() } }
}

describe('ToolWebPageView', () => {
  it('标题缺省回落 url，url 渲染为外链', async () => {
    const m = mount({ url: 'https://mao.etarch.cn/docs', title: '' })
    await nextTick()

    expect(document.querySelector('.page-title')?.textContent).toBe('https://mao.etarch.cn/docs')
    const link = document.querySelector('a.page-url') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://mao.etarch.cn/docs')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    m.destroy()
  })

  it('正文走 MarkdownContent 渲染', async () => {
    const m = mount({
      url: 'https://mao.etarch.cn',
      title: '标题',
      content: '# 一级标题\n\n正文段落',
    })
    await nextTick()
    await flush()

    const body = document.querySelector('.page-body')
    expect(body?.classList.contains('markdown-body')).toBe(true)
    expect(body?.innerHTML).toContain('一级标题')
    m.destroy()
  })

  it('无正文且无错误时展示空提示', async () => {
    const m = mount({ url: 'https://mao.etarch.cn', title: '标题', content: '' })
    await nextTick()

    expect(document.querySelector('.page-body')).toBeNull()
    expect(document.querySelector('.empty-hint')?.textContent).toBe('未提取到正文内容')
    m.destroy()
  })

  it('截断提示点击后派发 open-file（完整内容文件）', async () => {
    const m = mount({
      url: 'https://mao.etarch.cn',
      title: '标题',
      content: '正文',
      truncated: true,
      fullFile: '/ws/.mao/webpage/full.md',
    })
    await nextTick()

    const hint = document.querySelector('.page-truncated')
    expect(hint?.textContent).toContain('正文已截断')

    const btn = document.querySelector('.link-btn') as HTMLButtonElement
    btn.click()
    await nextTick()
    expect(m.opened).toEqual(['/ws/.mao/webpage/full.md'])
    m.destroy()
  })
})
