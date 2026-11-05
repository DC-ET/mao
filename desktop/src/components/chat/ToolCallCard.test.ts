/**
 * @vitest-environment jsdom
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import ToolCallCard from './ToolCallCard.vue'
import type { ToolCall } from '../../composables/useChat'

function mountCard(toolCall: ToolCall) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolCallCard, { toolCall })
    },
  })
  app.config.warnHandler = () => {}
  app.use(pinia)
  app.mount(el)
  return {
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

function findButton(text: string): HTMLButtonElement | null {
  for (const btn of Array.from(document.querySelectorAll('button'))) {
    if (btn.textContent?.trim() === text) return btn
  }
  return null
}

function resultLabels(): string[] {
  return Array.from(document.querySelectorAll('.result-label')).map(el => el.textContent?.trim() ?? '')
}

function makeEditCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc-1',
    name: 'edit_file',
    input: {
      path: '/ws/src/a.ts',
      old_string: 'const foo = 1\nconst bar = 2',
      new_string: 'const foo = 1\nconst baz = 3',
    },
    result: JSON.stringify({
      success: true,
      replacements: 1,
      file_change: { path: '/ws/src/a.ts', type: 'MODIFIED', lines_added: 1, lines_deleted: 1 },
    }),
    status: 'success',
    isExpanded: true,
    argsStreaming: false,
    ...overrides,
  }
}

describe('ToolCallCard edit_file diff 展示', () => {
  let mounted: ReturnType<typeof mountCard> | null = null
  afterEach(() => { mounted?.destroy() })

  it('默认只展示 diff 块 + 摘要底栏，不出现输入/输出标签与原始 JSON', async () => {
    mounted = mountCard(makeEditCall())
    await nextTick()

    const ctx = document.querySelector('.diff-line-context .diff-text')?.textContent
    const del = document.querySelector('.diff-line-del .diff-text')?.textContent
    const add = document.querySelector('.diff-line-add .diff-text')?.textContent
    expect(ctx).toBe('const foo = 1')
    expect(del).toBe('const bar = 2')
    expect(add).toBe('const baz = 3')

    // 摘要取后端 file_change 口径，与 diff 片段自算值无关
    const footer = document.querySelector('.diff-footer-row')
    expect(footer?.textContent).toContain('替换 1 处 · +1 -1')
    expect(findButton('查看原始输入输出')).toBeTruthy()

    // 默认不展示输入/输出两块
    expect(resultLabels()).toEqual([])
    expect(document.querySelector('pre.result-content')).toBeNull()
  })

  it('「查看原始输入输出」开关展开后才渲染输入/输出两块原始内容', async () => {
    mounted = mountCard(makeEditCall())
    await nextTick()

    findButton('查看原始输入输出')!.click()
    await nextTick()

    expect(resultLabels()).toEqual(['输入', '输出'])
    const pres = Array.from(document.querySelectorAll('pre.result-content code'))
      .map(el => el.textContent ?? '')
    expect(pres.some(t => t.includes('"new_string"'))).toBe(true)
    expect(pres.some(t => t.includes('"replacements":1'))).toBe(true)
    expect(findButton('收起原始输入输出')).toBeTruthy()

    // 再点一次收起
    findButton('收起原始输入输出')!.click()
    await nextTick()
    expect(resultLabels()).toEqual([])
    expect(document.querySelector('pre.result-content')).toBeNull()
  })

  it('编辑失败：摘要底栏直显 error 文案，diff 仍展示', async () => {
    mounted = mountCard(makeEditCall({
      status: 'error',
      result: JSON.stringify({
        success: false,
        replacements: 0,
        error: 'old_string 在文件中出现 3 次，默认只替换唯一匹配，未执行编辑。',
      }),
    }))
    await nextTick()

    expect(document.querySelector('.diff-footer-row')?.textContent)
      .toContain('old_string 在文件中出现 3 次')
    expect(document.querySelector('.diff-line-del .diff-text')?.textContent).toBe('const bar = 2')
  })

  it('执行中（无结果）：只展示 diff 与开关，无摘要', async () => {
    mounted = mountCard(makeEditCall({ status: 'running', result: undefined }))
    await nextTick()

    expect(document.querySelector('.diff-line-add .diff-text')?.textContent).toBe('const baz = 3')
    expect(document.querySelector('.edit-summary')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeTruthy()
  })

  it('非 edit_file 工具：保持原始 输入/输出 两块，不渲染 diff 与开关', async () => {
    mounted = mountCard({
      id: 'tc-2',
      name: 'shell',
      input: { command: 'ls -la' },
      result: '{"exit_code":0,"stdout":"total 0"}',
      status: 'success',
      isExpanded: true,
      argsStreaming: false,
    })
    await nextTick()

    expect(document.querySelector('.tool-diff')).toBeNull()
    expect(findButton('查看原始输入输出')).toBeNull()
    expect(resultLabels()).toEqual(['输入', '输出'])
    expect(document.querySelector('pre.result-content code')?.textContent)
      .toContain('"command"')
  })
})
