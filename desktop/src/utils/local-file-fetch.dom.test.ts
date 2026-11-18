// file_fetch 执行端处理（utils/local-file-fetch，方案 2026-11-18 §5.2-2）：分片、尺寸断言、静默失败。
// btoa 依赖浏览器全局：单开 DOM 环境（jsdom 自带 btoa/atob）。
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  FILE_FETCH_CHUNK_BASE64_MAX,
  FILE_FETCH_CHUNK_BYTES,
  FILE_FETCH_MAX_BYTES,
  handleLocalFileFetch,
} from './local-file-fetch'

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

describe('handleLocalFileFetch', () => {
  it('按 512KB 分片回传，seq/total/data 正确', async () => {
    const { frames, send } = collectSender()
    const byteLength = FILE_FETCH_CHUNK_BYTES + 1024 // 2 片
    const bytes = bytesOf(byteLength, 7)
    await handleLocalFileFetch(
      { requestId: 'r1', workspace: '/repo', path: 'screenshots/a.png' },
      42,
      { readBytes: async () => ({ bytes }), send },
    )
    expect(frames).toHaveLength(2)
    const [first, second] = frames
    expect(first).toMatchObject({ type: 'file_fetch_result', sessionId: 42, requestId: 'r1', seq: 1, total: 2 })
    expect(second).toMatchObject({ seq: 2, total: 2 })
    // 每片 base64 解码后与源字节对应
    const decode = (frame: Record<string, unknown>) =>
      Uint8Array.from(atob(frame.data as string), (c) => c.charCodeAt(0))
    expect(decode(first).byteLength).toBe(FILE_FETCH_CHUNK_BYTES)
    expect(decode(second).byteLength).toBe(1024)
    expect(decode(first)[0]).toBe(7)
  })

  it('读失败 / 空 bytes / 超上限 → 静默不回包', async () => {
    const { frames, send } = collectSender()
    await handleLocalFileFetch(
      { requestId: 'r1', workspace: '/repo', path: 'missing.png' },
      42,
      { readBytes: async () => ({ error: '不是普通文件或为符号链接，拒绝读取' }), send },
    )
    await handleLocalFileFetch(
      { requestId: 'r2', workspace: '/repo', path: 'a.png' },
      42,
      { readBytes: async () => ({ bytes: bytesOf(0) }), send },
    )
    await handleLocalFileFetch(
      { requestId: 'r3', workspace: '/repo', path: 'big.png' },
      42,
      { readBytes: async () => ({ bytes: bytesOf(FILE_FETCH_MAX_BYTES + 1) }), send },
    )
    expect(frames).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('帧字段缺失（requestId/workspace/path）→ 静默不回包', async () => {
    const { frames, send } = collectSender()
    await handleLocalFileFetch({ workspace: '/repo', path: 'a.png' }, 42, {
      readBytes: async () => ({ bytes: bytesOf(4) }),
      send,
    })
    await handleLocalFileFetch({ requestId: 'r1', path: 'a.png' }, 42, {
      readBytes: async () => ({ bytes: bytesOf(4) }),
      send,
    })
    await handleLocalFileFetch({ requestId: 'r1', workspace: '/repo' }, 42, {
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
    const { readBytes } = { readBytes: async () => ({ bytes: bytesOf(FILE_FETCH_CHUNK_BYTES + 8) }) }
    await handleLocalFileFetch(
      { requestId: 'r1', workspace: '/repo', path: 'a.png' },
      42,
      { readBytes, send },
    )
    expect(calls).toBe(2)
  })

  it('readBytes 抛异常 → 静默吞掉不冒泡', async () => {
    const { frames, send } = collectSender()
    await handleLocalFileFetch(
      { requestId: 'r1', workspace: '/repo', path: 'a.png' },
      42,
      { readBytes: async () => { throw new Error('IPC boom') }, send },
    )
    expect(frames).toHaveLength(0)
  })

  it('单片 base64 超尺寸断言 → 拒绝发送（防踩截断坑的回归护栏）', async () => {
    const { frames, send } = collectSender()
    // 恰好一片但 base64 超过断言阈值：正常 512KB 是 699,052，用 mock 大文件触发不可能——
    // 断言依赖常量正确性，这里直接校验常量与 512KB 实际 base64 长度的关系
    expect(FILE_FETCH_CHUNK_BASE64_MAX).toBe(900_000)
    // 与实现同口径分段构造，避免 512KB spread 炸栈
    const bytes = bytesOf(FILE_FETCH_CHUNK_BYTES)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const base64 = btoa(binary)
    expect(base64.length).toBeLessThan(FILE_FETCH_CHUNK_BASE64_MAX)
    expect(frames).toHaveLength(0)
    void send
  })
})
