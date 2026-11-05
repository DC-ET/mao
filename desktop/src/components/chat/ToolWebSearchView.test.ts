/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it } from 'vitest'
import ToolWebSearchView from './ToolWebSearchView.vue'
import type { WebSearchItem } from './ToolWebSearchView.vue'

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolWebSearchView, {
        query: '',
        items: [],
        error: '',
        ...props,
      })
    },
  })
  app.config.warnHandler = () => {}
  app.mount(el)
  return { destroy() { app.unmount(); el.remove() } }
}

const items: WebSearchItem[] = [
  { title: 'Vue 3 文档', url: 'https://cn.vuejs.org/guide/introduction.html', content: 'Vue 是渐进式框架' },
  { title: '', url: 'https://example.com/a', content: '' },
]

describe('ToolWebSearchView', () => {
  it('结果行渲染为外链：标题取 title（缺省回落 url）、host 从 url 解析', async () => {
    const m = mount({ items })
    await nextTick()

    const links = Array.from(document.querySelectorAll('a.result-row')) as HTMLAnchorElement[]
    expect(links).toHaveLength(2)
    expect(links[0].getAttribute('href')).toBe('https://cn.vuejs.org/guide/introduction.html')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer')

    expect(document.querySelectorAll('.result-title')[0].textContent).toBe('Vue 3 文档')
    expect(document.querySelectorAll('.result-host')[0].textContent).toBe('cn.vuejs.org')
    // 无 title 时标题回落为 url
    expect(document.querySelectorAll('.result-title')[1].textContent).toBe('https://example.com/a')
    m.destroy()
  })

  it('非法 url 的 host 回落为原始串', async () => {
    const m = mount({ items: [{ title: 'x', url: 'not-a-url', content: '' }] })
    await nextTick()

    expect(document.querySelector('.result-host')?.textContent).toBe('not-a-url')
    m.destroy()
  })

  it('无结果且无错误时展示空提示', async () => {
    const m = mount({ items: [] })
    await nextTick()

    expect(document.querySelector('.empty-hint')?.textContent).toBe('未找到相关结果')
    m.destroy()
  })
})
