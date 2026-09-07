import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAvatarUrl } from './avatar'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('resolveAvatarUrl', () => {
  it('保留空头像和 OSS 绝对地址', () => {
    expect(resolveAvatarUrl()).toBeUndefined()
    expect(resolveAvatarUrl(null)).toBeUndefined()
    expect(resolveAvatarUrl('')).toBeUndefined()
    expect(resolveAvatarUrl('https://oss.example.com/avatar.png')).toBe('https://oss.example.com/avatar.png')
  })

  it.each([
    ['https://mao.example.com/api/v1', 'https://mao.example.com/uploads/agents/1.png'],
    ['/api/v1', 'https://desktop.example.com/uploads/agents/1.png'],
    ['', 'http://localhost:9080/uploads/agents/1.png'],
  ])('按 API 地址 %s 解析上传路径', (base, expected) => {
    vi.stubEnv('VITE_API_BASE_URL', base)
    vi.stubGlobal('window', { location: { href: 'https://desktop.example.com/' } })
    expect(resolveAvatarUrl('/uploads/agents/1.png')).toBe(expected)
  })
})
