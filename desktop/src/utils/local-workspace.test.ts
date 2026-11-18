import { describe, expect, it } from 'vitest'
import { localWorkspaceDeviceLabel, resolveBrowserLocalTarget } from './local-workspace'
import type { LocalWorkspaceSummary } from '../stores/session'

function entry(overrides: Partial<LocalWorkspaceSummary> = {}): LocalWorkspaceSummary {
  return {
    workspace: 'D:\\code\\proj',
    name: 'proj',
    sessionCount: 2,
    activeSessions: 2,
    archivedSessions: 0,
    lastActiveAt: '2026-11-17 10:00:00',
    targetDeviceId: 'dev-a',
    targetDeviceName: 'DEV-A',
    targetDeviceOnline: true,
    executorClientType: 'electron',
    platform: 'win32',
    shell: 'powershell.exe',
    osVersion: '11',
    isGit: true,
    ...overrides,
  }
}

// 技术方案 2026-11-17 D6：浏览器新建 LOCAL 的设备沿用解析（端点条目 → 会话实体 → null）
describe('resolveBrowserLocalTarget', () => {
  it('命中端点条目：设备绑定与环境快照同源回显', () => {
    const resolved = resolveBrowserLocalTarget('D:\\code\\proj', [entry()], [])
    expect(resolved).not.toBeNull()
    expect(resolved!.deviceId).toBe('dev-a')
    expect(resolved!.deviceName).toBe('DEV-A')
    expect(resolved!.environmentInfo).toEqual({
      platform: 'win32', shell: 'powershell.exe', osVersion: '11', isGit: true,
    })
  })

  it('端点条目未绑定（纯历史遗留）：不猜设备，环境快照仍沿用', () => {
    const resolved = resolveBrowserLocalTarget('D:\\code\\proj', [entry({ targetDeviceId: null, targetDeviceName: null })], [])
    expect(resolved).not.toBeNull()
    expect(resolved!.deviceId).toBeNull()
    expect(resolved!.environmentInfo.platform).toBe('win32')
  })

  it('端点请求失败回落会话实体：取同路径已绑定的最近会话', () => {
    const resolved = resolveBrowserLocalTarget('D:\\code\\proj', [], [
      { id: '10', workspace: 'D:\\code\\proj', targetDeviceId: 'dev-old', targetDeviceName: 'OLD', platform: 'win32', shell: null, osVersion: null, isGit: false },
      { id: '22', workspace: 'D:\\code\\proj', targetDeviceId: 'dev-new', targetDeviceName: 'NEW', platform: 'win32', shell: 'pwsh.exe', osVersion: '11', isGit: true },
      { id: '30', workspace: 'D:\\other', targetDeviceId: 'dev-x', targetDeviceName: 'X', platform: 'win32', shell: null, osVersion: null, isGit: null },
    ] as never)
    expect(resolved!.deviceId).toBe('dev-new')
    expect(resolved!.deviceName).toBe('NEW')
    expect(resolved!.environmentInfo.isGit).toBe(true)
    expect(resolved!.environmentInfo.shell).toBe('pwsh.exe')
  })

  it('会话实体全未绑定：仅取环境快照，设备为 null', () => {
    const resolved = resolveBrowserLocalTarget('D:\\code\\proj', [], [
      { id: '10', workspace: 'D:\\code\\proj', targetDeviceId: null, targetDeviceName: null, platform: 'darwin', shell: null, osVersion: null, isGit: null },
    ] as never)
    expect(resolved!.deviceId).toBeNull()
    expect(resolved!.environmentInfo.platform).toBe('darwin')
  })

  it('全无数据返回 null（不猜设备，交服务端惰性认领兜底）', () => {
    expect(resolveBrowserLocalTarget('D:\\code\\proj', [], [])).toBeNull()
    expect(resolveBrowserLocalTarget('', [entry()], [])).toBeNull()
  })
})

describe('localWorkspaceDeviceLabel', () => {
  it('绑定设备：设备名 + 在线三态', () => {
    expect(localWorkspaceDeviceLabel(entry())).toBe('DEV-A · 在线')
    expect(localWorkspaceDeviceLabel(entry({ targetDeviceOnline: false }))).toBe('DEV-A · 离线')
    expect(localWorkspaceDeviceLabel(entry({ targetDeviceOnline: null }))).toBe('DEV-A')
  })

  it('未绑定：登记提示', () => {
    expect(localWorkspaceDeviceLabel(entry({ targetDeviceId: null, targetDeviceName: null }))).toBe('未登记执行端 · 首次发送时登记')
    expect(localWorkspaceDeviceLabel(entry({ targetDeviceId: null, targetDeviceName: 'DEV-A', targetDeviceOnline: null }))).toBe('DEV-A · 首次发送时登记')
    expect(localWorkspaceDeviceLabel(entry({ targetDeviceName: '', targetDeviceOnline: null }))).toBe('未登记执行端')
  })
})
