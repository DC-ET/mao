import { describe, expect, it } from 'vitest'
import { isLocalExecutorSession, terminalAvailability } from './terminal-availability'

const ELECTRON = { isElectronClient: true, hasTerminalUsePermission: true, localDeviceId: 'dev-a' }
const BROWSER = { isElectronClient: false, hasTerminalUsePermission: true, localDeviceId: null }

function localSession(overrides: Record<string, unknown> = {}) {
  return {
    executionMode: 'LOCAL',
    workspace: '/Users/u/proj',
    targetDeviceId: 'dev-a',
    targetDeviceOnline: true,
    terminalHost: 'enabled' as const,
    ...overrides,
  }
}

describe('terminalAvailability 矩阵（技术方案 2026-11-18 §4.2）', () => {
  it('无活跃会话 → 请先打开一个任务', () => {
    expect(terminalAvailability(null, ELECTRON)).toEqual({ enabled: false, tooltip: '请先打开一个任务' })
  })

  it('CLOUD：无权限 / 无工作区 / 正常', () => {
    const cloud = { executionMode: 'CLOUD', workspace: '/w' }
    expect(terminalAvailability(cloud, { ...ELECTRON, hasTerminalUsePermission: false }))
      .toEqual({ enabled: false, tooltip: '没有终端使用权限' })
    expect(terminalAvailability({ ...cloud, workspace: '' }, ELECTRON))
      .toEqual({ enabled: false, tooltip: '任务工作区不可用' })
    expect(terminalAvailability(cloud, ELECTRON)).toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
  })

  it('LOCAL 本机是执行端 → 启用（新建走 IPC），绑定缺失的存量会话同样按执行端', () => {
    expect(terminalAvailability(localSession(), ELECTRON)).toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
    expect(terminalAvailability(localSession({ targetDeviceId: null, terminalHost: null }), ELECTRON))
      .toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
    // 绑定在别的设备上：不是执行端
    expect(isLocalExecutorSession(localSession({ targetDeviceId: 'dev-b' }), ELECTRON)).toBe(false)
    expect(isLocalExecutorSession(localSession({ targetDeviceId: 'dev-a' }), ELECTRON)).toBe(true)
  })

  it('LOCAL 非执行端：工作区为空 / 未登记 / 离线按顺序给固定文案', () => {
    expect(terminalAvailability(localSession({ workspace: '' }), BROWSER))
      .toEqual({ enabled: false, tooltip: '任务工作区不可用' })
    expect(terminalAvailability(localSession({ targetDeviceId: null }), BROWSER))
      .toEqual({ enabled: false, tooltip: '请先在桌面客户端打开一次该任务，完成执行端登记' })
    expect(terminalAvailability(localSession({ targetDeviceOnline: false, terminalHost: null }), BROWSER))
      .toEqual({ enabled: false, tooltip: '执行端设备离线' })
  })

  it('LOCAL 非执行端：terminalHost 三种不可用快照的升级文案', () => {
    expect(terminalAvailability(localSession({ terminalHost: 'unsupported' }), BROWSER))
      .toEqual({ enabled: false, tooltip: '当前桌面客户端版本不支持远程终端，请升级桌面客户端' })
    expect(terminalAvailability(localSession({ terminalHost: 'upgrade-cli' }), BROWSER))
      .toEqual({ enabled: false, tooltip: '当前 mao-agent 版本不支持远程终端，请升级后重试' })
    expect(terminalAvailability(localSession({ terminalHost: 'upgrade-either' }), BROWSER))
      .toEqual({ enabled: false, tooltip: '请升级桌面客户端或 mao-agent 后使用远程终端' })
  })

  it('LOCAL 非执行端：enabled 与快照缺失（过渡态）都可点，失败文案由 REST 给出', () => {
    expect(terminalAvailability(localSession(), BROWSER)).toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
    expect(terminalAvailability(localSession({ terminalHost: null }), BROWSER))
      .toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
    expect(terminalAvailability(localSession({ terminalHost: undefined }), BROWSER))
      .toEqual({ enabled: true, tooltip: '终端 (Ctrl+`)' })
  })

  it('Electron 查看绑定在其它设备上的 LOCAL 会话：不再显示「本地终端可用」', () => {
    // 回归 §1.3：旧实现只看是否 Electron，双机会在自己电脑上开错机器的 shell
    const other = localSession({ targetDeviceId: 'dev-b', terminalHost: 'unsupported' })
    expect(terminalAvailability(other, ELECTRON).enabled).toBe(false)
    expect(terminalAvailability(other, ELECTRON).tooltip).toBe('当前桌面客户端版本不支持远程终端，请升级桌面客户端')
  })
})
