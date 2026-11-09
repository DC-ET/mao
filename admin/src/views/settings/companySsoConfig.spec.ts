import { describe, expect, it } from 'vitest'
import { defaultCompanySsoConfig, validateCompanySsoConfig } from './companySsoConfig'

const defaults = defaultCompanySsoConfig()
const base = { ...defaults, enabled: true, allowedDomains: ['example.com'] }
const originsOf = (allowedOrigins: string[]) => validateCompanySsoConfig({ ...base, allowedOrigins }).allowedOrigins

describe('公司 SSO 宿主 Origin 校验', () => {
  it('接受精确 HTTP/HTTPS Origin，含 localhost、IP 与非默认端口', () => {
    const origins = ['https://portal.example.com', 'https://portal.example.com:8443',
      'http://portal.example.com', 'http://localhost:2222', 'http://127.0.0.1:8080', 'http://[::1]:3000']
    expect(originsOf(origins)).toEqual(origins)
  })

  it('保留 HTTPS 子域模式与 * 全来源', () => {
    expect(originsOf(['https://*.example.com', 'https://*.example.com:8443', '*']))
      .toEqual(['https://*.example.com', 'https://*.example.com:8443', '*'])
  })

  it('拒绝 HTTP 子域模式与非规范或非 HTTP(S) 的精确 Origin', () => {
    for (const origin of ['http://*.example.com', 'http://*.example.com:8443', 'ftp://portal.example.com',
      'http://portal.example.com/', 'http://portal.example.com/path', 'http://portal.example.com?x=1',
      'http://portal.example.com#x', 'http://user:pass@portal.example.com', 'http://portal.example.com:80',
      'https://portal.example.com:443', 'HTTP://portal.example.com', 'https://*.EXAMPLE.com', 'null']) {
      expect(() => originsOf([origin]), origin).toThrow(/allowedOrigins/)
    }
  })

  it('拒绝 localhost/IP 的子域通配写法', () => {
    for (const origin of ['https://*.localhost', 'https://*.127.0.0.1', 'https://*.[::1]', 'http://*']) {
      expect(() => originsOf([origin]), origin).toThrow(/allowedOrigins/)
    }
  })
})
