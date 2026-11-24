import { describe, expect, it } from 'vitest'
import { resolveUpdateClickAction, summarizeUpdateError } from './update-click'
import type { AppUpdateStatus } from './update-click'

const base = { downloaded: false, available: false, android: false }

function action(status: AppUpdateStatus, patch: Partial<{ downloaded: boolean; available: boolean; android: boolean }> = {}) {
  return resolveUpdateClickAction({ ...base, ...patch, status })
}

describe('resolveUpdateClickAction', () => {
  it('更新检查失败时必须刷新页面（曾因只重试检查导致点击无响应）', () => {
    expect(action('error')).toBe('reload')
  })

  it('检查中 / 空闲 / 无更新 / 不支持自动更新时都立即刷新，不等待检查结果', () => {
    for (const status of ['checking', 'idle', 'not-available', 'unsupported'] as const) {
      expect(action(status)).toBe('reload')
    }
  })

  it('已下载待安装时弹安装确认，不刷新', () => {
    expect(action('downloaded')).toBe('install')
    expect(action('downloading', { downloaded: true })).toBe('install')
  })

  it('客户端更新下载中只提示进度，不打断下载', () => {
    expect(action('downloading')).toBe('progress')
    expect(action('downloading', { available: true })).toBe('progress')
  })

  it('发现 Electron 更新（自动下载中）同样保留页面', () => {
    expect(action('available', { available: true })).toBe('progress')
  })

  it('安卓 OTA 发现新包时弹更新确认', () => {
    expect(action('available', { available: true, android: true })).toBe('android-prompt')
  })
})

describe('summarizeUpdateError', () => {
  const raw = 'Cannot find channel "latest.yml" update info: HttpError: 404 Not Found\n'
    + '    at createError (node:internal/errors:1:1)\n'
    + '    at SimpleURLLoaderWrapper.<anonymous> (node:electron/js2c/browser_init:2:1)'

  it('只保留首行并限长，不把整段堆栈塞进 tooltip', () => {
    const text = summarizeUpdateError(raw)
    expect(text).toContain('客户端更新检查失败：')
    expect(text).toContain('（点击刷新页面）')
    expect(text).toContain('latest.yml')
    expect(text).not.toContain('at createError')
    expect(text).not.toContain('\n')
    expect(text.length).toBeLessThanOrEqual(90)
  })

  it('空错误信息也有可读提示', () => {
    expect(summarizeUpdateError(null)).toBe('客户端更新检查失败，点击刷新页面')
    expect(summarizeUpdateError('   ')).toBe('客户端更新检查失败，点击刷新页面')
  })
})