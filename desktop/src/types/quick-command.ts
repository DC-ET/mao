// 快捷指令契约来自共享包 @mao/contracts。
// 前端历史命名 QuickCommand / QuickCommandsData 与后端契约 QuickCommandItem / QuickCommandsVO 结构一致，
// 这里以类型别名保持前端既有引用路径不变。
import type { QuickCommandItem, QuickCommandsVO } from '@mao/contracts'

export type QuickCommand = QuickCommandItem
export type QuickCommandsData = QuickCommandsVO
