import { api } from '../api'

const SKILL_ONLY = /^\$\{([^}]+)\}\$$/
const SKILL_PATTERN = /\$\{[^}]+\}\$/g
const COMMAND_PATTERN = /#\{([^}]+)\}#/g

/**
 * 从用户消息推导会话标题（与主会话 useChat 逻辑一致）：
 * - 纯 skill 标记 → /skillName
 * - 剥离 skill / 文件引用标记
 * - 展开 #{command}# 快捷指令为指令正文
 */
export async function deriveSessionTitle(text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return '任务'

  const soleSkill = trimmed.match(SKILL_ONLY)
  if (soleSkill) return `/${soleSkill[1]}`

  let result = trimmed.replace(SKILL_PATTERN, '')
  result = result.replace(/@\{[^}]+\}@/g, '')

  const cmdNames = [...result.matchAll(COMMAND_PATTERN)].map(m => m[1])
  if (cmdNames.length > 0) {
    try {
      const { data } = await api.get('/user-commands')
      const cmdMap: Record<string, string> = {}
      for (const cmd of data || []) {
        cmdMap[cmd.name] = cmd.content
      }
      result = result.replace(COMMAND_PATTERN, (_, name) => cmdMap[name] || _)
    } catch {
      // If fetch fails, leave markers as-is
    }
  }

  result = result.trim()
  if (!result) return '任务'
  return result.length > 50 ? result.substring(0, 50) : result
}
