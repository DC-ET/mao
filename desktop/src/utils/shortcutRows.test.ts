// 迁移锁定（批次 29 提案 3 §4.1）：SHORTCUT_ROWS 单一数据源自 ShortcutHelpDialog 迁出，
// 文案与顺序必须与迁移前逐条一致——速查对话框与命令面板快捷键组共同消费此常量。
import { describe, expect, it } from 'vitest'
import { SHORTCUT_ROWS } from './shortcutRows'

describe('SHORTCUT_ROWS 迁移锁定', () => {
  it('7 条键位与动作与迁移前逐条一致', () => {
    expect(SHORTCUT_ROWS).toEqual([
      { keys: 'Ctrl/Cmd+K', action: '搜索会话' },
      { keys: 'Ctrl/Cmd+`', action: '打开/关闭终端' },
      { keys: 'Ctrl/Cmd+Shift+P', action: '命令面板' },
      { keys: '/', action: '输入框快捷指令' },
      { keys: 'Enter', action: '发送' },
      { keys: 'Shift+Enter', action: '换行' },
      { keys: 'Esc', action: '关闭浮层' }
    ])
  })
})
