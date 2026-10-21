import { describe, expect, it } from 'vitest'
import { isSensitiveHeaderKey } from './httpTool'

describe('isSensitiveHeaderKey', () => {
  it('按后端同款关键词命中敏感头', () => {
    expect(isSensitiveHeaderKey('Authorization')).toBe(true)
    expect(isSensitiveHeaderKey('X-Api-Key')).toBe(true)
    expect(isSensitiveHeaderKey('X-Client-Secret')).toBe(true)
    expect(isSensitiveHeaderKey('Cookie')).toBe(true)
    expect(isSensitiveHeaderKey('X-Access-Token')).toBe(true)
  })

  it('未命中关键词的头按普通值处理', () => {
    expect(isSensitiveHeaderKey('X-Credential')).toBe(false)
    expect(isSensitiveHeaderKey('X-Sign')).toBe(false)
    expect(isSensitiveHeaderKey('Content-Type')).toBe(false)
    expect(isSensitiveHeaderKey('')).toBe(false)
  })
})
