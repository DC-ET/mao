/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it } from 'vitest'
import ToolGrepView from './ToolGrepView.vue'

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const opened: string[] = []
  const app = createApp({
    setup() {
      return () => h(ToolGrepView, {
        pattern: 'foo',
        glob: '',
        path: '',
        ignoreCase: false,
        groups: [],
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

const groups = [
  {
    file: 'src/a.ts',
    rows: [
      { line: 10, content: 'const foo = 1', contextual: false },
      { line: 11, content: '// 上下文行', contextual: true },
    ],
  },
]

describe('ToolGrepView', () => {
  it('点击文件头派发 open-file', async () => {
    const m = mount({ groups })
    await nextTick()

    const header = document.querySelector('.match-file') as HTMLElement
    header.click()
    await nextTick()
    expect(m.opened).toEqual(['src/a.ts'])
    m.destroy()
  })

  it('上下文行带 contextual 类（淡显），命中行不带', async () => {
    const m = mount({ groups })
    await nextTick()

    const rows = Array.from(document.querySelectorAll('.match-row'))
    expect(rows[0].classList.contains('contextual')).toBe(false)
    expect(rows[1].classList.contains('contextual')).toBe(true)
    m.destroy()
  })

  it('命中行内匹配片段高亮', async () => {
    const m = mount({ groups })
    await nextTick()

    expect(document.querySelector('.hit')?.textContent).toBe('foo')
    m.destroy()
  })
})
