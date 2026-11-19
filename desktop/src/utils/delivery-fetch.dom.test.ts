// delivery_fetch 执行端处理（utils/delivery-fetch，统一发送媒体方案 2026-11-18 §6.2）：分片、maxBytes、静默失败。
// btoa 依赖浏览器全局：单开 DOM 环境（jsdom 自带 btoa/atob）。
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_FETCH_CHUNK_BASE64_MAX,
  DELIVERY_FETCH_CHUNK_BYTES,
  DELIVERY_FETCH_MAX_BYTES,
  handleDeliveryFetch,
} from './delivery-fetch'

function bytesOf(byteLength: number, fill = 1): Uint8Array {
  return new Uint8Array(byteLength).fill(fill)
}

/** 收集 send 调用帧。 */
function collectSender() {
  const frames: Array<Record<string, unknown>> = []
  const send = vi.fn(async (payload: Record<string, unknown>) => {
    frames.push(payload)
    return true
  })
  return { frames, send }
}

describe('handleDeliveryFetch', () => {
  it('按 512KB 分片回传 delivery_fetch_result，seq/total/data 正确', async () => {
    const { frames, send } = collectSender()
    const byteLength = DELIVERY_FETCH_CHUNK_BYTES + 1024 // 2 片
    const bytes = bytesOf(byteLength, 7)
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: 'screenshots/a.png', maxBytes: DELIVERY_FETCH_MAX_BYTES },
      42,
      { readBytes: async () => ({ bytes }), send },
    )
    expect(frames).toHaveLength(2)
    const [first, second] = frames
    expect(first).toMatchObject({ type: 'delivery_fetch_result', sessionId: 42, requestId: 'r1', seq: 1, total: 2 })
    expect(second).toMatchObject({ seq: 2, total: 2 })
    const decode = (frame: Record<string, unknown>) =>
      Uint8Array.from(atob(frame.data as string), (c) => c.charCodeAt(0))
    expect(decode(first).byteLength).toBe(DELIVERY_FETCH_CHUNK_BYTES)
    expect(decode(second).byteLength).toBe(1024)
    expect(decode(first)[0]).toBe(7)
  })

  it('帧 maxBytes 生效：超过服务端副本上限 → 静默不回包（图片会话 20MB）', async () => {
    const { frames, send } = collectSender()
    const reads: Array<{ maxBytes: number }> = []
    const twenty = 20 * 1024 * 1024
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: 'a.png', maxBytes: twenty },
      42,
      { readBytes: async (payload) => { reads.push(payload); return { bytes: bytesOf(twenty + 1) } }, send },
    )
    // 帧内上限下传到主进程，避免按 30MB 读整份后才丢弃
    expect(reads[0]!.maxBytes).toBe(twenty)
    expect(frames).toHaveLength(0)
  })

  it('maxBytes 非法时按 30MB 兜底；30MB 上限生效', async () => {
    const { frames, send } = collectSender()
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: 'big.bin' },
      42,
      { readBytes: async () => ({ bytes: bytesOf(DELIVERY_FETCH_MAX_BYTES + 1) }), send },
    )
    await handleDeliveryFetch(
      { requestId: 'r2', workspace: '/repo', path: 'big.bin', maxBytes: Number.NaN },
      42,
      { readBytes: async () => ({ bytes: bytesOf(DELIVERY_FETCH_MAX_BYTES + 1) }), send },
    )
    expect(frames).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('读失败 / 空 bytes → 静默不回包（含 workspace 内绝对路径入参透传）', async () => {
    const { frames, send } = collectSender()
    const reads: Array<{ workspace: string; path: string; maxBytes: number }> = []
    const readBytes = vi.fn(async (payload: { workspace: string; path: string; maxBytes: number }) => {
      reads.push(payload)
      return { error: '不是普通文件或为符号链接，拒绝读取' }
    })
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: '/repo/inside/a.png', maxBytes: DELIVERY_FETCH_MAX_BYTES },
      42,
      { readBytes, send },
    )
    await handleDeliveryFetch(
      { requestId: 'r2', workspace: '/repo', path: 'a.png', maxBytes: DELIVERY_FETCH_MAX_BYTES },
      42,
      { readBytes: async () => ({ bytes: bytesOf(0) }), send },
    )
    expect(reads[0]).toEqual({ workspace: '/repo', path: '/repo/inside/a.png', maxBytes: DELIVERY_FETCH_MAX_BYTES })
    expect(frames).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('帧字段缺失（requestId/workspace/path）→ 静默不回包', async () => {
    const { frames, send } = collectSender()
    await handleDeliveryFetch({ workspace: '/repo', path: 'a.png' }, 42, {
      readBytes: async () => ({ bytes: bytesOf(4) }),
      send,
    })
    await handleDeliveryFetch({ requestId: 'r1', path: 'a.png' }, 42, {
      readBytes: async () => ({ bytes: bytesOf(4) }),
      send,
    })
    await handleDeliveryFetch({ requestId: 'r1', workspace: '/repo' }, 42, {
      readBytes: async () => ({ bytes: bytesOf(4) }),
      send,
    })
    expect(frames).toHaveLength(0)
  })

  it('send 中途失败 → 立即停止（服务端超时收敛），已发分片不回滚', async () => {
    let calls = 0
    const send = vi.fn(async () => {
      calls += 1
      return calls < 2 // 第 2 片发送失败
    })
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: 'a.bin', maxBytes: DELIVERY_FETCH_MAX_BYTES },
      42,
      { readBytes: async () => ({ bytes: bytesOf(DELIVERY_FETCH_CHUNK_BYTES + 8) }), send },
    )
    expect(calls).toBe(2)
  })

  it('readBytes 抛异常 → 静默吞掉不冒泡', async () => {
    const { frames, send } = collectSender()
    await handleDeliveryFetch(
      { requestId: 'r1', workspace: '/repo', path: 'a.png', maxBytes: DELIVERY_FETCH_MAX_BYTES },
      42,
      { readBytes: async () => { throw new Error('IPC boom') }, send },
    )
    expect(frames).toHaveLength(0)
  })

  it('单片 base64 尺寸断言与 512KB 实际 base64 长度的关系（防截断回归护栏）', () => {
    expect(DELIVERY_FETCH_CHUNK_BASE64_MAX).toBe(900_000)
    const bytes = bytesOf(DELIVERY_FETCH_CHUNK_BYTES)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const base64 = btoa(binary)
    expect(base64.length).toBeLessThan(DELIVERY_FETCH_CHUNK_BASE64_MAX)
  })
})
