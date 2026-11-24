import type { CommandVisibility } from '@mao/contracts'

/** 系统指令可见范围。漏一项时 vue-tsc 会报错。 */
export const COMMAND_VISIBILITY_LABELS: Record<CommandVisibility, string> = {
  all: '全局',
  roles: '指定角色',
}
