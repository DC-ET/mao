import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { androidReleaseManifestUrl, apiBaseUrl, siteBaseUrl, wsBaseUrl } from './api-base'

function stubWindow(protocol = 'https:', origin = 'https://mao.example.com', host = 'mao.example.com') {
  vi.stubGlobal('window', { location: { protocol, origin, host } })
}

beforeEach(() => {
  // Vitest 默认是 test mode，不会读 .env.development；显式清空避免外部环境变量干扰。
  vi.stubEnv('VITE_API_BASE_URL', '')
  vi.stubEnv('VITE_WS_BASE_URL', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('apiBaseUrl', () => {
  it('env 覆盖优先，并去掉尾部斜杠', () => {
    vi.stubEnv('VITE_API_BASE_URL', ' https://api.example.com/api/v1/ ')
    expect(apiBaseUrl()).toBe('https://api.example.com/api/v1')
  })

  it('无 env 时跟随当前页面 origin', () => {
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(apiBaseUrl()).toBe('https://mao.example.com/api/v1')
  })

  it('HTTP 页面同源推导，不做 HTTPS 强制', () => {
    stubWindow('http:', 'http://10.0.0.8:8080', '10.0.0.8:8080')
    expect(apiBaseUrl()).toBe('http://10.0.0.8:8080/api/v1')
  })

  it('file: 等非 http(s) 页面回落 localhost', () => {
    stubWindow('file:', 'null', '')
    expect(apiBaseUrl()).toBe('http://localhost:9080/api/v1')
  })

  it('Node 无 window 回落 localhost', () => {
    expect(apiBaseUrl()).toBe('http://localhost:9080/api/v1')
  })

  it('window 被 stub 但无 location 时回落 localhost', () => {
    vi.stubGlobal('window', {})
    expect(apiBaseUrl()).toBe('http://localhost:9080/api/v1')
  })
})

describe('wsBaseUrl', () => {
  it('env 覆盖优先，并去掉尾部斜杠', () => {
    vi.stubEnv('VITE_WS_BASE_URL', 'wss://api.example.com/api/')
    expect(wsBaseUrl()).toBe('wss://api.example.com/api')
  })

  it('https 同源转 wss', () => {
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(wsBaseUrl()).toBe('wss://mao.example.com/api')
  })

  it('http 同源转 ws', () => {
    stubWindow('http:', 'http://10.0.0.8:8080', '10.0.0.8:8080')
    expect(wsBaseUrl()).toBe('ws://10.0.0.8:8080/api')
  })

  it('相对 env 在页面 origin 上拼 ws/wss', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1')
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(wsBaseUrl()).toBe('wss://mao.example.com/api')
  })

  it('相对 env 且 window 无 location 时回落 localhost', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1')
    vi.stubGlobal('window', {})
    expect(wsBaseUrl()).toBe('ws://localhost:9080/api')
  })
})

describe('siteBaseUrl / androidReleaseManifestUrl', () => {
  it('同源时去掉 /api/v1', () => {
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(siteBaseUrl()).toBe('https://mao.example.com')
    expect(androidReleaseManifestUrl()).toBe('https://mao.example.com/uploads/releases/android-latest.json')
  })

  it('相对 env 时 OTA 仍跟随页面站点 origin', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api/v1')
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(siteBaseUrl()).toBe('https://mao.example.com')
    expect(androidReleaseManifestUrl()).toBe('https://mao.example.com/uploads/releases/android-latest.json')
  })

  it('split-domain 时 OTA 用 SPA origin，而不是 API 域', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.com/api/v1')
    stubWindow('https:', 'https://mao.example.com', 'mao.example.com')
    expect(apiBaseUrl()).toBe('https://api.example.com/api/v1')
    expect(siteBaseUrl()).toBe('https://mao.example.com')
    expect(androidReleaseManifestUrl()).toBe('https://mao.example.com/uploads/releases/android-latest.json')
  })

  it('子路径显式 env 保留子路径（特殊部署，无 window 时）', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://mao.example.com/mao/api/v1')
    expect(apiBaseUrl()).toBe('https://mao.example.com/mao/api/v1')
    expect(siteBaseUrl()).toBe('https://mao.example.com/mao')
    expect(wsBaseUrl()).toBe('wss://mao.example.com/mao/api')
  })
})