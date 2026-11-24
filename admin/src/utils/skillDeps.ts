import type { SkillDepsItem, SkillDepsPhase, SkillDepsStatusMap } from '@mao/contracts'

/** Skills 页「运行依赖」列的 phase 默认文案。漏一项时 vue-tsc 会报错。 */
export const SKILL_DEPS_PHASE_TEXT: Record<SkillDepsPhase, string> = {
  not_installed: '依赖未安装',
  installing: '依赖安装中',
  ready: '依赖就绪',
  failed: '依赖安装失败',
}

const PHASE_TAG_TYPE: Record<SkillDepsPhase, 'info' | 'warning' | 'success' | 'danger'> = {
  not_installed: 'info',
  installing: 'warning',
  ready: 'success',
  failed: 'danger',
}

export function depsFor(map: SkillDepsStatusMap, skillName: string): SkillDepsItem[] | undefined {
  const items = map[skillName]?.items
  return items != null && items.length > 0 ? items : undefined
}

export function phaseText(item: SkillDepsItem): string {
  return item.text ?? SKILL_DEPS_PHASE_TEXT[item.phase]
}

export function phaseTagType(phase: SkillDepsPhase) {
  return PHASE_TAG_TYPE[phase]
}

/** 安装按钮对应的条目：安装由 provider 一次负责全部可安装项，任一项安装中则不出按钮。 */
export function primaryInstallable(items: readonly SkillDepsItem[] | undefined): SkillDepsItem | null {
  const installs = (items ?? []).filter((item) => item.kind === 'install')
  if (installs.some((item) => item.phase === 'installing')) return null
  return installs.find((item) => item.phase !== 'ready') ?? null
}

export function installConfirmText(item: SkillDepsItem): string {
  return item.installConfirm ?? `将在服务器上自动安装${item.label}，可能需要数分钟，确认开始？`
}

/** 配置页可达性：ok 可跳；forbidden 无该页权限；missing 路由不存在。 */
export type ConfigRouteAccess = 'ok' | 'forbidden' | 'missing'

export interface ConfigActionView {
  label: string
  route: string
  enabled: boolean
  /** 不可点时的 tooltip。 */
  reason: string | null
}

/** 第一个未就绪且带配置入口的 config 条目；权限判断经 access 注入，保持纯函数可测。 */
export function configAction(
  items: readonly SkillDepsItem[] | undefined,
  access: (route: string) => ConfigRouteAccess,
): ConfigActionView | null {
  const item = (items ?? []).find((it) => it.kind === 'config' && it.phase !== 'ready' && it.action != null)
  if (item?.action == null) return null
  const result = access(item.action.route)
  return {
    label: item.action.label,
    route: item.action.route,
    enabled: result === 'ok',
    reason: result === 'forbidden' ? '无该配置页的访问权限' : result === 'missing' ? '配置页不存在' : null,
  }
}

export function hasInstalling(map: SkillDepsStatusMap): boolean {
  return Object.values(map).some((entry) => entry.items.some((item) => item.phase === 'installing'))
}
