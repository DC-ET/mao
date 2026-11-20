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
})
