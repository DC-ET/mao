import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const el = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
  confirm: vi.fn(),
}))

const ws = vi.hoisted(() => {
  const callbacks = new Map<string, (sessionId: string) => void>()
  let seq = 0
  return {
    callbacks,
    reset() {
      callbacks.clear()
      seq = 0
    },
    onMessageSaved: vi.fn((callback: (sessionId: string) => void) => {
      const id = `cb-${++seq}`
      callbacks.set(id, callback)
      return id
    }),
    offMessageSaved: vi.fn((id: string) => {
      callbacks.delete(id)
    }),
    pendingCallbacks: new Map<string, unknown>(),
    clearActiveExecution: vi.fn(),
    insertMessage: vi.fn(async () => true),
    deleteQueueMessage: vi.fn(async () => true),
    reorderQueueMessage: vi.fn(async () => true),
  }
})

vi.mock('element-plus', () => ({
  ElMessage: { error: el.error, warning: el.warning },
  ElMessageBox: { confirm: el.confirm },
}))
vi.mock('./useStreamWS', () => ({ useStreamWS: () => ws }))
vi.mock('../api', () => ({ api: { get: vi.fn(async () => ({ data: [] })) } }))

import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from '../stores/session'
import {
  awaitExecutionSettled,
  finalizeCancelledSession,
  guardUploadsBeforeSend,
  waitForMessageSaved,
} from './chatSessionActions'
import { useChatQueue } from './useChatQueue'

/** 取出当前注册的 user_message_saved 回调（每次只发一条） */
function savedCallback(): (sessionId: string) => void {
  const cb = [...ws.callbacks.values()][0]
  expect(cb, '未注册 user_message_saved 监听').toBeTypeOf('function')
  return cb!
}

describe('guardUploadsBeforeSend（主会话 / 边路共用的上传防线）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    el.confirm.mockResolvedValue('confirm')
  })

  it('附件全部失败：阻断并提示', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 1, imageUrls: [], fileCount: 1, uploadedFileCount: 0, resolvedText: '你好',
    })
    expect(ok).toBe(false)
    expect(el.error).toHaveBeenCalledWith('附件全部上传失败，已取消发送')
  })

  it('部分失败且用户取消：阻断，不再提示错误', async () => {
    el.confirm.mockRejectedValueOnce(new Error('cancel'))
    const ok = await guardUploadsBeforeSend({
      imageCount: 2, imageUrls: ['a.png'], fileCount: 0, uploadedFileCount: 0, resolvedText: '你好',
    })
    expect(ok).toBe(false)
    expect(el.confirm).toHaveBeenCalledTimes(1)
    expect(el.error).not.toHaveBeenCalled()
  })

  it('部分失败但用户确认：继续发送', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 2, imageUrls: ['a.png'], fileCount: 0, uploadedFileCount: 0, resolvedText: '你好',
    })
    expect(ok).toBe(true)
  })

  it('内容为空且没有图片：阻断并提示', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 0, imageUrls: [], fileCount: 0, uploadedFileCount: 0, resolvedText: '   ',
    })
    expect(ok).toBe(false)
    expect(el.warning).toHaveBeenCalledWith('消息内容为空，已取消发送')
  })

  it('全部成功：放行', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 1, imageUrls: ['a.png'], fileCount: 1, uploadedFileCount: 1, resolvedText: '',
    })
    expect(ok).toBe(true)
    expect(el.confirm).not.toHaveBeenCalled()
  })

  it('failureLabel=拷贝（LOCAL 附件）：文案随动作切换', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 0, imageUrls: [], fileCount: 1, uploadedFileCount: 0, resolvedText: '你好',
      failureLabel: '拷贝',
    })
    expect(ok).toBe(false)
    expect(el.error).toHaveBeenCalledWith('附件全部拷贝失败，已取消发送')
  })

  it('failureLabel=拷贝（LOCAL 附件）：部分失败二次确认文案同步切换', async () => {
    const ok = await guardUploadsBeforeSend({
      imageCount: 1, imageUrls: ['a.png'], fileCount: 2, uploadedFileCount: 1, resolvedText: '你好',
      failureLabel: '拷贝',
    })
    expect(ok).toBe(true)
    expect(el.confirm).toHaveBeenCalledWith(
      '1 个附件拷贝失败，仍要发送其余内容吗？',
      '部分附件处理失败',
      expect.objectContaining({ confirmButtonText: '仍然发送' })
    )
  })
})

describe('waitForMessageSaved（发送后等待落库确认）', () => {
  beforeEach(() => {
    ws.reset()
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('收到本会话确认后返回 true，并解绑监听', async () => {
    const pending = waitForMessageSaved('12')
    savedCallback()('12')
    await expect(pending).resolves.toBe(true)
    expect(ws.offMessageSaved).toHaveBeenCalledWith('cb-1')
    expect(ws.callbacks.size).toBe(0)
  })

  it('别的会话的确认不算数', async () => {
    vi.useFakeTimers()
    const pending = waitForMessageSaved('12', { timeoutMs: 100 })
    savedCallback()('99')
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe(false)
  })

  it('支持 getter：边路首发在等待期间回填会话 id 仍能匹配', async () => {
    let expected: string | null = null
    const pending = waitForMessageSaved(() => expected)
    expected = '31'
    savedCallback()('31')
    await expect(pending).resolves.toBe(true)
  })

  it('注册前就已 abort：立即返回 false，不注册监听', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForMessageSaved('12', { signal: controller.signal })).resolves.toBe(false)
    expect(ws.callbacks.size).toBe(0)
  })

  it('abort 后立即返回 false 并解绑（面板卸载 / 创建被拒）', async () => {
    const controller = new AbortController()
    const pending = waitForMessageSaved('12', { signal: controller.signal })
    const cb = savedCallback()
    controller.abort()
    await expect(pending).resolves.toBe(false)
    expect(ws.callbacks.size).toBe(0)
    // 解绑后再收到确认不应重复 resolve
    cb('12')
    expect(ws.callbacks.size).toBe(0)
  })
})

describe('finalizeCancelledSession / awaitExecutionSettled', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    ws.reset()
    vi.clearAllMocks()
  })

  it('先标记中断再置终态，并唤醒等待收敛的调用方', async () => {
    const store = useSessionStore()
    const order: string[] = []
    vi.spyOn(store, 'finishInterruptedStreamingMessage').mockImplementation(() => { order.push('interrupted') })
    vi.spyOn(store, 'updateSessionPhase').mockImplementation(() => { order.push('phase') })

    const waiting = awaitExecutionSettled('30')
    finalizeCancelledSession('30')

    await expect(waiting).resolves.toBeUndefined()
    // 顺序敏感：REST 覆盖前必须先给流式气泡打上中断标记，否则唯一副本会被删掉
    expect(order).toEqual(['interrupted', 'phase'])
    expect(ws.pendingCallbacks.has('30')).toBe(false)
  })

  it('同一会话只保留最后一个等待者，旧等待者显式失败', async () => {
    const first = awaitExecutionSettled('30')
    const second = awaitExecutionSettled('30')
    await expect(first).rejects.toThrow('superseded')

    finalizeCancelledSession('30')
    await expect(second).resolves.toBeUndefined()
  })
})

describe('useChatQueue', () => {
  const input = {
    hasDraft: vi.fn(() => false),
    restoreContent: vi.fn(),
    focusInput: vi.fn(),
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('没有会话时全部短路：不请求、不报错', async () => {
    const { api } = await import('../api')
    const queue = useChatQueue(() => null)
    await queue.fetchQueue()
    await expect(queue.insertQueueMessage('q1')).resolves.toBeUndefined()
    await expect(queue.reorderQueueMessage('q1', 0)).resolves.toBeUndefined()
    await expect(queue.deleteQueueMessage('q1')).resolves.toBe(false)
    expect(vi.mocked(api.get)).not.toHaveBeenCalled()
  })

  it('撤回编辑：删除成功才回填输入框', async () => {
    const queue = useChatQueue(() => '30', () => input)
    await queue.handleQueueEdit({ id: 'q1', content: '原文', images: [] } as never)
    expect(input.restoreContent).toHaveBeenCalledWith('原文', [])
    expect(input.focusInput).toHaveBeenCalled()
  })

  it('没有输入框时不删队列项（避免内容静默丢失）', async () => {
    const queue = useChatQueue(() => '30', () => null)
    await queue.handleQueueEdit({ id: 'q1', content: '原文', images: [] } as never)
    expect(ws.deleteQueueMessage).not.toHaveBeenCalled()
  })

  it('删除队列项失败时不回填输入框', async () => {
    vi.mocked(ws.deleteQueueMessage).mockResolvedValueOnce(false)
    const queue = useChatQueue(() => '30', () => input)
    await queue.handleQueueEdit({ id: 'q1', content: '原文', images: [] } as never)
    expect(input.restoreContent).not.toHaveBeenCalled()
  })
})
