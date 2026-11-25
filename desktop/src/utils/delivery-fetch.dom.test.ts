// delivery_read 执行端处理（utils/delivery-fetch，2026-11-25 send_file 1GB R2）：
// open / read / close 三段、区间上限、错误显式回包。
// btoa 依赖浏览器全局：单开 DOM 环境（jsdom 自带 btoa/atob）。
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_READ_CHUNK_BYTES,
  DELIVERY_READ_MAX_BYTES,
  handleDeliveryRead,
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

function depsOf(overrides: Partial<Parameters<typeof handleDeliveryRead>[2]> = {}) {
  const { frames, send } = collectSender()
  const open = vi.fn(async () => ({ ok: true, openId: 'open-1', size: DELIVERY_READ_CHUNK_BYTES + 1024, mtimeMs: 123 }))
  const read = vi.fn(async () => ({
    ok: true,
    bytes: bytesOf(DELIVERY_READ_CHUNK_BYTES, 7),
    size: DELIVERY_READ_CHUNK_BYTES + 1024,
    mtimeMs: 123,
  }))
  const digest = vi.fn(async () => ({ ok: true, sha256: 'abc123', size: DELIVERY_READ_CHUNK_BYTES + 1024, mtimeMs: 123 }))
  const close = vi.fn(async () => ({ ok: true }))
  const deps = { open, read, digest, close, send, ...overrides }
  return { frames, send, open, read, digest, close, deps }
}

const OPEN_FRAME = {
  requestId: 'r-open',
  action: 'open',
  streamId: 's1',
  workspace: '/repo',
  path: 'big.bin',
  maxBytes: DELIVERY_READ_MAX_BYTES,
}

describe('handleDeliveryRead', () => {
  it('open 回 size / mtimeMs，read 按 offset 取一片并以 base64 回包', async () => {
    const { frames, deps, open, read } = depsOf()
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    await handleDeliveryRead(
      { requestId: 'r1', action: 'read', streamId: 's1', offset: 0, length: DELIVERY_READ_CHUNK_BYTES },
      42,
      deps,
    )
    expect(open).toHaveBeenCalledWith({
      workspace: '/repo',
      path: 'big.bin',
      maxBytes: DELIVERY_READ_MAX_BYTES,
    })
    expect(frames[0]).toMatchObject({ type: 'delivery_read_result', sessionId: 42, requestId: 'r-open', ok: true, size: DELIVERY_READ_CHUNK_BYTES + 1024, mtimeMs: 123 })
    expect(frames[1]).toMatchObject({ type: 'delivery_read_result', requestId: 'r1', ok: true, size: DELIVERY_READ_CHUNK_BYTES + 1024 })
    const decoded = Uint8Array.from(atob(frames[1]!.data as string), (c) => c.charCodeAt(0))
    expect(decoded.byteLength).toBe(DELIVERY_READ_CHUNK_BYTES)
    expect(decoded[0]).toBe(7)
    expect(read).toHaveBeenCalledWith({ openId: 'open-1', offset: 0, length: DELIVERY_READ_CHUNK_BYTES })
  })

  it('open 失败（如文件过大）显式回 ok:false，服务端据此给准确文案', async () => {
    const { frames, deps } = depsOf({
      open: vi.fn(async () => ({ error: '文件过大（2048MB），上限 1024MB' })),
    })
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ ok: false, error: '文件过大（2048MB），上限 1024MB' })
  })

  it('maxBytes 钳制到 1GB 上限后再下传主进程', async () => {
    const { deps, open } = depsOf()
    await handleDeliveryRead({ ...OPEN_FRAME, maxBytes: 8 * 1024 * 1024 * 1024 }, 42, deps)
    expect((open.mock.calls[0] as unknown[])[0]).toMatchObject({ maxBytes: DELIVERY_READ_MAX_BYTES })
  })

  it('未 open 就 read / 区间非法 / 超过单片上限 → 回错误', async () => {
    const { frames, deps } = depsOf()
    await handleDeliveryRead({ requestId: 'r1', action: 'read', streamId: 'missing', offset: 0, length: 1 }, 42, deps)
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    await handleDeliveryRead({ requestId: 'r2', action: 'read', streamId: 's1', offset: -1, length: 1 }, 42, deps)
    await handleDeliveryRead({ requestId: 'r3', action: 'read', streamId: 's1', offset: 0, length: DELIVERY_READ_CHUNK_BYTES + 1 }, 42, deps)
    expect(frames.filter((f) => f.ok === false)).toHaveLength(3)
  })

  it('digest：按 streamId 找回句柄并回整份 sha256（R8），不把文件读进渲染进程', async () => {
    const { frames, deps, digest } = depsOf()
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    await handleDeliveryRead({ requestId: 'r-digest', action: 'digest', streamId: 's1' }, 42, deps)
    expect(digest).toHaveBeenCalledWith({ openId: 'open-1' })
    expect(frames.at(-1)).toMatchObject({ type: 'delivery_read_result', ok: true, sha256: 'abc123' })
  })

  it('open 回包发送失败（连接不可写）：立刻关闭刚打开的句柄', async () => {
    const { deps, close } = depsOf({ send: vi.fn(async () => false) })
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    expect(close).toHaveBeenCalledWith({ openId: 'open-1' })
  })

  it('read / digest 回包发送失败：同样当场关闭句柄，不等 60 秒空闲回收', async () => {
    for (const action of ['read', 'digest'] as const) {
      // open 的回包正常，只有本次 read/digest 的回包失败
      const send = vi.fn(async (payload: Record<string, unknown>) => payload.requestId !== 'r-test')
      const { deps, close } = depsOf({ send })
      await handleDeliveryRead(OPEN_FRAME, 42, deps)
      expect(close).not.toHaveBeenCalled()
      await handleDeliveryRead(
        { requestId: 'r-test', action, streamId: 's1', offset: 0, length: 8 },
        42,
        deps,
      )
      expect(close).toHaveBeenCalledWith({ openId: 'open-1' })
    }
  })

  it('close 释放句柄；close 后 read 回「已关闭」', async () => {
    const { frames, deps, close } = depsOf()
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    await handleDeliveryRead({ requestId: 'r-close', action: 'close', streamId: 's1' }, 42, deps)
    await handleDeliveryRead({ requestId: 'r2', action: 'read', streamId: 's1', offset: 0, length: 4 }, 42, deps)
    expect(close).toHaveBeenCalledWith({ openId: 'open-1' })
    const last = frames.at(-1)!
    expect(last).toMatchObject({ ok: false })
  })

  it('read 抛异常 → 回 ok:false 不冒泡', async () => {
    const { frames, deps } = depsOf({
      read: vi.fn(async () => { throw new Error('IPC boom') }),
    })
    await handleDeliveryRead(OPEN_FRAME, 42, deps)
    await handleDeliveryRead({ requestId: 'r1', action: 'read', streamId: 's1', offset: 0, length: 4 }, 42, deps)
    expect(frames.at(-1)).toMatchObject({ ok: false, error: 'IPC boom' })
  })

  it('帧字段缺失（requestId / streamId / workspace / path）→ 静默不回包', async () => {
    const { frames, deps } = depsOf()
    await handleDeliveryRead({ action: 'open', streamId: 's1', workspace: '/repo', path: 'a' }, 42, deps)
    await handleDeliveryRead({ requestId: 'r1', action: 'open', workspace: '/repo', path: 'a' }, 42, deps)
    await handleDeliveryRead({ requestId: 'r1', action: 'open', streamId: 's1', path: 'a' }, 42, deps)
    await handleDeliveryRead({ requestId: 'r1', action: 'open', streamId: 's1', workspace: '/repo' }, 42, deps)
    expect(frames).toHaveLength(0)
  })
})
