/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { describe, expect, it } from 'vitest'
import ToolGlobView from './ToolGlobView.vue'

function mount(props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const opened: string[] = []
  const app = createApp({
    setup() {
      return () => h(ToolGlobView, {
        pattern: '*.ts',
        path: '',
        searchRoot: '/ws',
        files: [],
        truncated: false,
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

describe('ToolGlobView', () => {
  it('点击文件行派发 open-file，载荷为完整路径', async () => {
    const m = mount({ files: ['src/App.vue', 'README.md'] })
    await nextTick()

    const rows = Array.from(document.querySelectorAll('.file-row')) as HTMLElement[]
    expect(rows).toHaveLength(2)
    rows[0].click()
    await nextTick()
    expect(m.opened).toEqual(['src/App.vue'])
    m.destroy()
  })

  it('无目录的路径：dir 为空、name 为全路径', async () => {
    const m = mount({ files: ['README.md'] })
    await nextTick()

    expect(document.querySelector('.file-dir')?.textContent).toBe('')
    expect(document.querySelector('.file-name')?.textContent).toBe('README.md')
    m.destroy()
  })
})
