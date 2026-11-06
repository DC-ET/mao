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

/** 卡片行上的工具图标（.tool-icon）：只有充当组壳的 standalone 卡片才挂 */
function cardIconCount(): number {
  return document.querySelectorAll('.tool-call-card .tool-icon').length
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
    // 组头没了，工具类型图标由卡片头补上（否则看不出是哪类工具）
    expect(cardIconCount()).toBe(1)
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
    // 组头已带工具类型图标，组内每行不再重复挂（否则一个组里出现 N+1 个图标）
    expect(cardIconCount()).toBe(0)
    expect(document.querySelectorAll('.tool-group-header .tool-group-icon')).toHaveLength(1)
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

  it('组内有执行中调用：组头显示最早开始的 running 调用耗时', async () => {
    const m = mountGroup([
      makeCall('tc-1', { status: 'success', startedAtMs: Date.now() - 5_000 }),
      makeCall('tc-2', { status: 'running', result: undefined, startedAtMs: Date.now() - 90_000 }),
      makeCall('tc-3', { status: 'running', result: undefined, startedAtMs: Date.now() - 30_000 }),
    ])
    await nextTick()

    // 已成功的不参与（它的计时到结果事件即停）；两个 running 里取最早开始的
    expect(document.querySelector('.group-status .tool-elapsed')?.textContent).toBe('1m30s')
    m.destroy()
  })

  it('组内无执行中调用、或 running 无起表时刻：组头不显示耗时', async () => {
    const m = mountGroup([
      makeCall('tc-1', { status: 'success', startedAtMs: Date.now() - 90_000 }),
      makeCall('tc-2', { status: 'error', startedAtMs: Date.now() - 30_000 }),
    ])
    await nextTick()
    expect(document.querySelector('.tool-elapsed')).toBeNull()
    m.destroy()

    // running 但没有起表时刻（历史态/兜底）：只留 spinner，不显示 0
    const m2 = mountGroup([
      makeCall('tc-1', { status: 'running', result: undefined }),
      makeCall('tc-2', { status: 'success' }),
    ])
    await nextTick()
    expect(document.querySelector('.tool-elapsed')).toBeNull()
    expect(document.querySelector('.group-status .status-spinner')).not.toBeNull()
    m2.destroy()
  })
})
