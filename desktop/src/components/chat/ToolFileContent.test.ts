/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it } from 'vitest'
import ToolFileContent from './ToolFileContent.vue'

function mountContent(props: { content: string; startLine?: number }) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolFileContent, props)
    },
  })
  app.config.warnHandler = () => {}
  app.mount(el)
  return {
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

describe('ToolFileContent', () => {
  it('默认渲染行号槽，空行占位为单空格', async () => {
    const mounted = mountContent({ content: 'a\n\nb' })
    await nextTick()

    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['1', '2', '3'])
    const texts = Array.from(document.querySelectorAll('.line-text')).map(el => el.textContent)
    expect(texts).toEqual(['a', ' ', 'b'])
    mounted.destroy()
  })

  it('startLine 指定起始行号（read_file offset 分页）', async () => {
    const mounted = mountContent({ content: 'x\ny', startLine: 41 })
    await nextTick()

    const nos = Array.from(document.querySelectorAll('.line-no')).map(el => el.textContent)
    expect(nos).toEqual(['41', '42'])
    mounted.destroy()
  })

  it('超过 2000 行降级为纯文本块，不渲染行号行', async () => {
    const content = Array.from({ length: 2001 }, (_, i) => `l${i}`).join('\n')
    const mounted = mountContent({ content })
    await nextTick()

    expect(document.querySelectorAll('.file-line')).toHaveLength(0)
    expect(document.querySelector('.file-plain code')?.textContent).toBe(content)
    mounted.destroy()
  })
})
