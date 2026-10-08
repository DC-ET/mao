/**
 * 审批规则「将保存为」预览的归一化口径。
 * 必须与 backend-ts/src/approval-rule/approval-rule-normalize.ts 的 normalizeShellCommand 一致：
 * 只剥首部连续的 env 赋值前缀、折叠空白；中段出现的赋值属于命令本身，必须原样保留。
 */

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_-]*=/

/** 剥除首部连续 env 赋值 token（FOO=bar …）。 */
export function stripLeadingEnvTokens(tokens: string[]): string[] {
  let start = 0
  while (start < tokens.length && ENV_ASSIGNMENT.test(tokens[start])) start++
  return tokens.slice(start)
}

/**
 * 预览规则值：MCP 工具取输入原文（服务端只 trim + 截断）；
 * shell 取归一化后的全文（SHELL_EXACT）或前两个 token（SHELL_PREFIX）。
 */
export function previewRuleValue(ruleType: string, raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  if (ruleType === 'MCP_TOOL') return trimmed
  const tokens = stripLeadingEnvTokens(trimmed.split(/\s+/).filter(t => t !== ''))
  if (tokens.length === 0) return ''
  return ruleType === 'SHELL_PREFIX' ? tokens.slice(0, 2).join(' ') : tokens.join(' ')
}
