/**
 * Agent 表单的 Git 凭据域映射（技术方案 2026-11-06 §3.6）。
 *
 * 三态语义（必须区分 undefined 与 null）：
 * - VO 侧：null = 未配置（开关关闭）；[] = 显式禁止（开关开启 + 空列表）；非空 = 白名单。
 * - 请求体侧：关闭 → null；开启 + 空 → []；非空 → 去空白、去重的白名单。
 *
 * 抽成纯函数的原因：admin 单测基建只覆盖纯逻辑、不引入组件测试框架（见 vitest.config.ts）。
 */

/** 回显：后端返回 null/undefined 视为开关关闭，[] 视为开启 + 空列表。 */
export function gitDomainsEnabledOf(value: string[] | null | undefined): boolean {
  return value !== null && value !== undefined
}

/** 回显：把 VO 数组复制为表单列表（null/undefined → 空列表）。 */
export function gitDomainsListOf(value: string[] | null | undefined): string[] {
  return Array.isArray(value) ? [...value] : []
}

/** 提交：关闭 → null（不限制）；开启 → 去空白、去重后的数组（空数组 = 显式禁止）。 */
export function gitDomainsPayload(enabled: boolean, list: string[]): string[] | null {
  if (!enabled) return null
  return [...new Set(list.map((domain) => domain.trim()).filter((domain) => domain !== ''))]
}
