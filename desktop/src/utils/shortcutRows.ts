/**
 * 快捷键速查表单一数据源（批次 29 提案 3 §4.1，自 ShortcutHelpDialog 迁出）：
 * ShortcutHelpDialog（全局 `?` / 面板命令打开）与命令面板快捷键组（面板内 `?`）共同消费；
 * 新增快捷键（如批次 29 提案 4 审批键盘流）在此 +1 条即两端同步。
 */

export interface ShortcutRow {
  keys: string
  action: string
}

/** 7 条静态速查（批次 25 技术方案 §2.3 帮助表）；键位与 TopNav handleSearchShortcut / ChatInput 既有行为一致。 */
export const SHORTCUT_ROWS: ReadonlyArray<ShortcutRow> = [
  { keys: 'Ctrl/Cmd+K', action: '搜索会话' },
  { keys: 'Ctrl/Cmd+`', action: '打开/关闭终端' },
  { keys: 'Ctrl/Cmd+Shift+P', action: '命令面板' },
  { keys: '/', action: '输入框快捷指令' },
  { keys: 'Enter', action: '发送' },
  { keys: 'Shift+Enter', action: '换行' },
  { keys: 'Esc', action: '关闭浮层' },
  { keys: 'Y / N', action: '审批待决卡片（执行 / 拒绝）' }
]
