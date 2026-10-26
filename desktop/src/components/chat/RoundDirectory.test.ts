// 轮次目录浮层的打开 / 关闭 / 定位行为（jsdom 真实挂载，验证 document 事件监听生命周期）。
// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import RoundDirectory from './RoundDirectory.vue'

vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    ;(window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  }
})

function msg(id: string, role: string, extra: Record<string, unknown> = {}) {
  return { id, role, content: '', createdAt: '2026-10-20T10:00:00', ...extra } as any
}

function twoRounds() {
  return [
    msg('u1', 'user', { content: '帮我重构登录流程' }),
    msg('a1', 'assistant', { content: '第一轮完成' }),
    msg('u2', 'user', { content: '把单元测试也补上' }),
    msg('a2', 'assistant', { content: '第二轮完成' }),
  ]
}

function mount(props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const onLocate = vi.fn()
  const app = createApp({ render: () => h(RoundDirectory as any, { messages: twoRounds(), sending: false, onLocate, ...props } as any) })
  app.mount(host)
  return { host, onLocate, app }
}

function q(host: HTMLElement, sel: string) {
  return host.querySelector(sel) as HTMLElement | null
}

describe('轮次目录浮层交互', () => {
  it('点把手打开浮层，点行定位到该轮用户消息并收起', async () => {
    const { host, onLocate, app } = mount()
    const handle = q(host, '.round-directory-handle')!
    expect(handle).toBeTruthy()
    expect(q(host, '.round-directory-popover')).toBeNull()

    handle.click()
    await Promise.resolve()
    const popover = q(host, '.round-directory-popover')
    expect(popover).toBeTruthy()
    const rows = host.querySelectorAll('.round-directory-row')
    expect(rows.length).toBe(2)

    ;(rows[1] as HTMLElement).click()
    await Promise.resolve()
    expect(onLocate).toHaveBeenCalledWith('u2')
    // 定位后浮层收起
    expect(q(host, '.round-directory-popover')).toBeNull()
    app.unmount()
  })

  it('Esc 收起浮层', async () => {
    const { host, app } = mount()
    q(host, '.round-directory-handle')!.click()
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeTruthy()

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeNull()
    app.unmount()
  })

  it('点浮层外部收起', async () => {
    const { host, app } = mount()
    q(host, '.round-directory-handle')!.click()
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeTruthy()

    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeNull()
    app.unmount()
  })

  it('把手上的 @click.stop 挡住 document 关闭处理器：再次点把手走 toggle 收起', async () => {
    const { host, app } = mount()
    const handle = q(host, '.round-directory-handle')!
    handle.click()
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeTruthy()
    // 再次点把手：事件不到 document，由 toggle 收起（不是被外部点击处理器关掉）
    handle.click()
    await Promise.resolve()
    expect(q(host, '.round-directory-popover')).toBeNull()
    app.unmount()
  })
})
