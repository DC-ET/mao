/**
 * @vitest-environment jsdom
 */
import { nextTick, h, ref } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'

// 同 ToolCallCard.test.ts：ToolFileContent 间接引入 theme.ts（import 期读 window.matchMedia）
// 与 monaco-colorize（真加载 monaco-editor）
vi.mock('../../utils/theme', () => ({
  useTheme: () => ({ isDark: ref(false) }),
}))
vi.mock('../../utils/monaco-colorize', () => ({
  colorizeCode: vi.fn(async (text: string) => `<code class="monaco-code">${text}</code>`),
}))

import ToolCallGroup from './ToolCallGroup.vue'
import type { ToolCall } from '../../composables/useChat'

function mountGroup(toolCalls: ToolCall[]) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ToolCallGroup, { toolCalls })
    },
  })
  app.config.warnHandler = () => {}
  app.use(pinia)
  app.mount(el)
  return { destroy() { app.unmount(); el.remove() } }
}

function makeCall(id: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name: 'shell',
    input: { action: 'exec', command: 'npm run build' },
    result: JSON.stringify({ exit_code: 0, output: 'build done' }),
    status: 'success',
    isExpanded: false,
    argsStreaming: false,
    ...overrides,
  }
}

function hasGroupHeader(): boolean {
  return !!document.querySelector('.tool-group-header')
}

function toolBodyVisible(): boolean {
  return !!document.querySelector('.tool-body')
}

describe('ToolCallGroup', () => {
  it('单工具组不渲染组头：一次点击卡片头即展开内容', async () => {
    const m = mountGroup([makeCall('tc-1', { summary: '执行 npm run build (2 行输出)' })])
    await nextTick()

    // 组头与卡片头信息重复，单工具组直接省掉组头
    expect(hasGroupHeader()).toBe(false)
    expect(document.querySelector('.tool-header')).not.toBeNull()
    // 但组壳的点击热区/悬停反馈不能丢：卡片头带 standalone 样式充当组壳
    expect(document.querySelector('.tool-call-card')?.classList.contains('standalone')).toBe(true)
    expect(toolBodyVisible()).toBe(false)

    const header = document.querySelector('.tool-header') as HTMLElement
    header.click()
    await nextTick()
    expect(toolBodyVisible()).toBe(true)
    m.destroy()
  })

  it('多工具组保留组头：先点组头展开列表，再点卡片头看内容', async () => {
    const m = mountGroup([
      makeCall('tc-1', { summary: '执行 a' }),
      makeCall('tc-2', { summary: '执行 b' }),
    ])
    await nextTick()

    expect(hasGroupHeader()).toBe(true)
    expect(toolBodyVisible()).toBe(false)

    const groupHeader = document.querySelector('.tool-group-header') as HTMLElement
    groupHeader.click()
    await nextTick()
    // 组头只负责展开列表，卡片内容仍需各卡片自己的点击
    expect(document.querySelectorAll('.tool-header')).toHaveLength(2)
    // 多调用组内的卡片不带 standalone（热区/悬停由组壳负责，避免每行都一片底色）
    expect(document.querySelector('.tool-call-card')?.classList.contains('standalone')).toBe(false)
    expect(toolBodyVisible()).toBe(false)

    const cardHeader = document.querySelector('.tool-header') as HTMLElement
    cardHeader.click()
    await nextTick()
    expect(toolBodyVisible()).toBe(true)
    m.destroy()
  })

  it('多工具组组头汇总同类工具次数', async () => {
    const m = mountGroup([
      makeCall('tc-1', { name: 'read_file' }),
      makeCall('tc-2', { name: 'read_file' }),
      makeCall('tc-3', { name: 'shell' }),
    ])
    await nextTick()

    expect(document.querySelector('.group-summary')?.textContent).toBe('2次读取文件、执行命令')
    m.destroy()
  })
})
