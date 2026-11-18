/**
 * 本地任务中继终端（技术方案 2026-11-18-local-terminal-remote）。
 *
 * `TerminalHostAvailability` 描述绑定设备上「终端主机」的可用状态：主机是执行端
 * 设备上的 Electron 主进程或 mao-agent 进程（PTY 在那台机器上，服务器只登记转发）。
 * 该值出现在会话快照（`SessionVO.terminalHost`）与 `device_status` 广播里，
 * 前端据此渲染终端按钮的禁用态与 tooltip；漏改汉化表由 `Record` 穷尽在编译期报错。
 */
export type TerminalHostAvailability = 'enabled' | 'unsupported' | 'upgrade-cli' | 'upgrade-either';

/** 后端按 `as const satisfies` 收口允许值，防止手写脏值进快照。 */
export const TERMINAL_HOST_AVAILABILITIES = [
  'enabled',
  'unsupported',
  'upgrade-cli',
  'upgrade-either',
] as const satisfies readonly TerminalHostAvailability[];
