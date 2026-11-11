/**
 * @vitest-environment jsdom
 */
// 全局状态指示器（批次 29 提案 5）：标题双源 watch（并行状态 + 登录态，登出必复位）与
// flash 期望态沿（immediate 启动即闪 / 关开关即时停 / Web 无桥接零调用）。
// 真实链路：驱动 pinia sessionStore 投影（standardSessionIds + upsertSessionEntity）。
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStatusIndicators } from './useParallelStatus'
import { useSessionStore, type Session } from '../stores/session'
import { useAuthStore } from '../stores/auth'
import { resetApprovalFlashForTest } from '../utils/approvalFlashPreference'

function sessionEntity(overrides: Partial<Session> = {}): Session {
  return {
    id: '9901',
    title: 't',
    phase: 'COMPLETED',
    status: 'ACTIVE',
    workspace: '/ws',
    executionMode: 'CLOUD',
    ...overrides,
  } as unknown as Session
}

describe('useAppStatusIndicators', () => {
  let flashFrame: ReturnType<typeof vi.fn>
  let sessionStore: ReturnType<typeof useSessionStore>
  let authStore: ReturnType<typeof useAuthStore>
  // 指示器 watcher 注册在独立 effectScope（非组件作用域），必须显式 stop——
  // 否则跨测试共享 window.electronAPI / 偏好 ref 会互串（前一用例的 watcher 在后用例触发）
  const stops: Array<() => void> = []

  beforeEach(() => {
    setActivePinia(createPinia())
    sessionStore = useSessionStore()
    authStore = useAuthStore()
    localStorage.removeItem('aw-approval-flash')
    resetApprovalFlashForTest(true)
    flashFrame = vi.fn(async () => ({ ok: true }))
    ;(window as any).electronAPI = { flashFrame }
    document.title = 'Mao'
    // 登录态在位：标题带前缀；Electron 桥接在位：flash 生效
    authStore.user = { id: 1 } as any
  })

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
    delete (window as any).electronAPI
  })

  function register() {
    stops.push(useAppStatusIndicators())
  }

  async function flush() {
    await nextTick()
    await Promise.resolve()
    await nextTick()
  }

  function seedSession(overrides: Partial<Session>) {
    sessionStore.upsertSessionEntity(sessionEntity(overrides))
    sessionStore.standardSessionIds = ['9901']
  }

  it('启动即有等待审批：immediate 沿触发 flash(true)，标题带前缀', async () => {
    seedSession({ phase: 'WAITING_APPROVAL' })
    register()
    await flush()

    expect(document.title).toBe('❗ 等待审批 · Mao')
    expect(flashFrame).toHaveBeenCalledTimes(1)
    expect(flashFrame).toHaveBeenCalledWith(true)
  })

  it('裁决后复位：标题回 Mao、flash(false)；failed 态标题 ✗', async () => {
    seedSession({ phase: 'WAITING_APPROVAL' })
    register()
    await flush()

    seedSession({ phase: 'COMPLETED' })
    await flush()
    expect(document.title).toBe('Mao')
    expect(flashFrame).toHaveBeenLastCalledWith(false)

    seedSession({ phase: 'FAILED' })
    await flush()
    expect(document.title).toBe('✗ 有会话失败 · Mao')
    expect(flashFrame).toHaveBeenCalledTimes(2) // 失败不闪，flash 无新沿
  })

  it('登出复位标题 Mao（双源 watch：user 清空即触发，不依赖 status 变化）', async () => {
    seedSession({ phase: 'WAITING_APPROVAL' })
    register()
    await flush()
    expect(document.title).toBe('❗ 等待审批 · Mao')

    authStore.user = null
    await flush()
    expect(document.title).toBe('Mao')
  })

  it('关闭开关瞬间正在闪烁：即时 flash(false)，标题前缀保留', async () => {
    seedSession({ phase: 'WAITING_APPROVAL' })
    register()
    await flush()
    expect(flashFrame).toHaveBeenCalledWith(true)

    resetApprovalFlashForTest(false)
    await flush()
    expect(flashFrame).toHaveBeenLastCalledWith(false)
    expect(document.title).toBe('❗ 等待审批 · Mao') // 标题态不受开关控制
  })

  it('Web（无 electronAPI）：标题态生效，flash 全程零调用', async () => {
    delete (window as any).electronAPI
    seedSession({ phase: 'WAITING_APPROVAL' })
    register()
    await flush()

    expect(document.title).toBe('❗ 等待审批 · Mao')
    expect(flashFrame).not.toHaveBeenCalled()
  })
})
