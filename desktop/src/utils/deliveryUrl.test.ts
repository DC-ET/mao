// 发送媒体活引用取数 URL（2026-11-20-send-media-live-reference §5.2）：
// 形态 A（ref）渲染期拼 workspace-download + token，token 绝不入消息 JSON；
// 形态 B/C 原样返回 url。key 用稳定身份，不用含 token 的 resolved URL。
import { describe, expect, it, vi } from 'vitest'
import { deliveryKey, resolveDeliveryUrl, resolveDeliveryUrlWithToken } from './deliveryUrl'
import type { SendDelivery } from '../types/chat'

vi.mock('./auth-storage', () => ({ getToken: () => 'from-storage' }))

const refDelivery: SendDelivery = {
  kind: 'image',
  ref: { type: 'workspace', sessionId: 42, path: 'reports/图 片.png' },
  mime: 'image/png',
  bytes: 123,
  filename: '图 片.png',
}

const urlDelivery: SendDelivery = {
  kind: 'file',
  url: 'https://mao.example.com/uploads/7/send-abc.pdf',
  mime: 'application/pdf',
  bytes: 9,
  filename: 'a.pdf',
}

describe('resolveDeliveryUrl', () => {
  it('形态 A：拼 workspace-download，token 渲染期追加', () => {
    const url = resolveDeliveryUrl(refDelivery, 'jwt-token')
    expect(url).toBe(
      'http://localhost:9080/api/v1/files/workspace-download?sessionId=42&path=reports%2F%E5%9B%BE%20%E7%89%87.png&token=jwt-token',
    )
  })

  it('形态 A：无 token 时不带 token 参数（401 由端点给出，图片走既有占位）', () => {
    const url = resolveDeliveryUrl(refDelivery, null)
    expect(url).toContain('sessionId=42')
    expect(url).toContain('path=reports%2F%E5%9B%BE%20%E7%89%87.png')
    expect(url).not.toContain('token')
  })

  it('形态 B/C：原样返回 url，不追加 token', () => {
    expect(resolveDeliveryUrl(urlDelivery, 'jwt-token')).toBe(urlDelivery.url)
  })
})

describe('deliveryKey', () => {
  it('形态 A 用 ref（sessionId + type + path）做稳定 key，与 token 无关', () => {
    const key = deliveryKey(refDelivery)
    expect(key).toBe('ref:42:workspace:reports/图 片.png')
    expect(deliveryKey(refDelivery)).toBe(key)
  })

  it('形态 B/C 用 url 做 key', () => {
    expect(deliveryKey(urlDelivery)).toBe('https://mao.example.com/uploads/7/send-abc.pdf')
  })
})

describe('resolveDeliveryUrlWithToken', () => {
  it('形态 A：token 取自 auth-storage 的 getToken（渲染期读取）', () => {
    expect(resolveDeliveryUrlWithToken(refDelivery)).toBe(
      'http://localhost:9080/api/v1/files/workspace-download?sessionId=42&path=reports%2F%E5%9B%BE%20%E7%89%87.png&token=from-storage',
    )
  })

  it('形态 B/C：不经 auth-storage，原样返回 url', () => {
    expect(resolveDeliveryUrlWithToken(urlDelivery)).toBe(urlDelivery.url)
  })

  it('send-file 快照：token 同样取自 auth-storage 的 getToken（渲染期读取）', () => {
    expect(resolveDeliveryUrlWithToken(snapshotDelivery)).toBe(
      'http://localhost:9080/api/v1/files/send-download?id=2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f&token=from-storage',
    )
  })
})

// 2026-11-24-send-file-snapshot：send-file 快照 ref（新发送默认形态）。消息只带快照 id，
// 取数拼带属主鉴权的 send-download，只传 id 不传路径；key 用快照 id 做稳定身份。
const snapshotDelivery: SendDelivery = {
  kind: 'image',
  ref: { type: 'send-file', id: '2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f' },
  mime: 'image/png',
  bytes: 123,
  filename: '图 片.png',
}

describe('resolveDeliveryUrl：send-file 快照', () => {
  it('拼 send-download，只传 id 与 token', () => {
    expect(resolveDeliveryUrl(snapshotDelivery, 'jwt-token')).toBe(
      'http://localhost:9080/api/v1/files/send-download?id=2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f&token=jwt-token',
    )
  })

  it('无 token 时不带 token 参数', () => {
    const url = resolveDeliveryUrl(snapshotDelivery, null)
    expect(url).toBe('http://localhost:9080/api/v1/files/send-download?id=2f8a1c11-9c1e-4a1f-8f6e-1d2b3c4d5e6f')
  })

  it('与 workspace ref 分派不混：同 id 不会拼出 sessionId/path', () => {
    expect(resolveDeliveryUrl(snapshotDelivery, 't')).not.toContain('sessionId')
    expect(resolveDeliveryUrl(snapshotDelivery, 't')).not.toContain('path=')
  })
})

describe('deliveryKey：send-file 快照', () => {
  it('用快照 id 做 key，同一轮多个快照不撞', () => {
    const a = { ...snapshotDelivery, ref: { type: 'send-file' as const, id: 'id-a' } }
    const b = { ...snapshotDelivery, ref: { type: 'send-file' as const, id: 'id-b' } }
    expect(deliveryKey(a)).toBe('send-file:id-a')
    expect(deliveryKey(b)).toBe('send-file:id-b')
    // 回归：不分派 type 会得到 ref:undefined:send-file:undefined，N 个快照共用一个 key
    expect(deliveryKey(a)).not.toBe(deliveryKey(b))
    expect(deliveryKey(a)).not.toContain('undefined')
  })

  it('与 workspace ref / url 三种 key 互不相同的空间', () => {
    expect(deliveryKey(snapshotDelivery)).not.toBe(deliveryKey(refDelivery))
    expect(deliveryKey(snapshotDelivery)).not.toBe(deliveryKey(urlDelivery))
  })
})
