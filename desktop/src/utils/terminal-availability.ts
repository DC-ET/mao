import type { TerminalHostAvailability } from '@mao/contracts'

/**
 * 终端按钮可用性矩阵（技术方案 2026-11-18-local-terminal-remote §4.2）。
 *
 * 纯函数：TopNav 的 computed 与命令面板的 canUseTerminal 都只调它；测试覆盖矩阵的
 * 每一行。先判定「本机是不是这条会话的执行端」（Electron + deviceId 对上会话绑定，
 * 或绑定缺失按存量未登记会话处理），再按 CLOUD / LOCAL 分支走。
 */

export interface TerminalAvailabilitySession {
  executionMode?: string | null
  workspace?: string | null
  targetDeviceId?: string | null
  targetDeviceOnline?: boolean | null
  /** 绑定设备的终端主机快照；缺省 / 离线为 null（设备在线且无快照 = 过渡态，按钮可点） */
  terminalHost?: TerminalHostAvailability | null
}

export interface TerminalAvailabilityContext {
  /** 本机是否 Electron（Web / 安卓 Capacitor 为 false） */
  isElectronClient: boolean
  /** terminal:use 权限（只作用于 CLOUD 服务器终端） */
  hasTerminalUsePermission: boolean
  /** 本机 deviceId（Electron 下经 IPC 取共享设备文件；Web / 安卓为 null） */
  localDeviceId: string | null
}

export interface TerminalAvailability {
  enabled: boolean
  tooltip: string
}

/** 本机是不是这条 LOCAL 会话的执行端：绑定缺失（存量未登记）按执行端处理（§4.2）。 */
export function isLocalExecutorSession(
  session: TerminalAvailabilitySession | null | undefined,
  ctx: TerminalAvailabilityContext,
): boolean {
  if (!ctx.isElectronClient) return false
  const bound = session?.targetDeviceId
  if (bound == null || bound === '') return true
  return bound === ctx.localDeviceId
}

export function terminalAvailability(
  session: TerminalAvailabilitySession | null | undefined,
  ctx: TerminalAvailabilityContext,
): TerminalAvailability {
  if (!session) return { enabled: false, tooltip: '请先打开一个任务' }
  if (session.executionMode === 'CLOUD') {
    if (!ctx.hasTerminalUsePermission) return { enabled: false, tooltip: '没有终端使用权限' }
    if (!session.workspace) return { enabled: false, tooltip: '任务工作区不可用' }
    return { enabled: true, tooltip: '终端 (Ctrl+`)' }
  }
  // LOCAL：本机是执行端（含绑定缺失的存量会话）→ 本机 IPC，行为与改造前一致（矩阵第 1 行）
  if (isLocalExecutorSession(session, ctx)) {
    return { enabled: true, tooltip: '终端 (Ctrl+`)' }
  }
  // 其余客户端走中继：PTY 在绑定设备上，机器因素按矩阵顺序给出固定文案
  if (!session.workspace) return { enabled: false, tooltip: '任务工作区不可用' }
  if (session.targetDeviceId == null || session.targetDeviceId === '') {
    return { enabled: false, tooltip: '请先在桌面客户端打开一次该任务，完成执行端登记' }
  }
  if (session.targetDeviceOnline !== true) {
    return { enabled: false, tooltip: '执行端设备离线' }
  }
  switch (session.terminalHost) {
    case 'unsupported':
      return { enabled: false, tooltip: '当前桌面客户端版本不支持远程终端，请升级桌面客户端' }
    case 'upgrade-cli':
      return { enabled: false, tooltip: '当前 mao-agent 版本不支持远程终端，请升级后重试' }
    case 'upgrade-either':
      return { enabled: false, tooltip: '请升级桌面客户端或 mao-agent 后使用远程终端' }
    default:
      // enabled / 快照缺失（后端未升级或未推到）：按钮可点，具体原因由 REST 给出（§4.2 末行）
      return { enabled: true, tooltip: '终端 (Ctrl+`)' }
  }
}
