import { describe, expect, it } from 'vitest'
import { previewRuleValue, stripLeadingEnvTokens } from './approvalRulePreview'

describe('previewRuleValue', () => {
  it('SHELL_PREFIX 取归一化后前两个 token', () => {
    expect(previewRuleValue('SHELL_PREFIX', 'git push origin main')).toBe('git push')
    expect(previewRuleValue('SHELL_PREFIX', '  npm   run  build ')).toBe('npm run')
    expect(previewRuleValue('SHELL_PREFIX', 'ls')).toBe('ls')
  })

  it('SHELL_EXACT 取归一化全文', () => {
    expect(previewRuleValue('SHELL_EXACT', '  npm   run  build ')).toBe('npm run build')
  })

  it('只剥首部连续 env 赋值，与后端 normalizeShellCommand 口径一致', () => {
    expect(previewRuleValue('SHELL_EXACT', 'FOO=bar npm run build')).toBe('npm run build')
    expect(previewRuleValue('SHELL_EXACT', 'FOO=1 BAR=2 npm run build')).toBe('npm run build')
    // 中段的赋值属于命令本身：预览不得比服务端实际落库值更短
    expect(previewRuleValue('SHELL_EXACT', 'npm run FOO=bar build')).toBe('npm run FOO=bar build')
    expect(previewRuleValue('SHELL_PREFIX', 'FOO=1 npm run FOO=2 build')).toBe('npm run')
  })

  it('MCP_TOOL 取输入原文', () => {
    expect(previewRuleValue('MCP_TOOL', ' mcp__srv__tool ')).toBe('mcp__srv__tool')
  })

  it('空输入返回空串', () => {
    expect(previewRuleValue('SHELL_EXACT', '   ')).toBe('')
    expect(previewRuleValue('MCP_TOOL', '')).toBe('')
    // 纯 env 赋值没有剩余 token
    expect(previewRuleValue('SHELL_EXACT', 'FOO=bar')).toBe('')
  })
})

describe('stripLeadingEnvTokens', () => {
  it('剥到首个非赋值 token 为止', () => {
    expect(stripLeadingEnvTokens(['FOO=1', 'BAR=2', 'npm', 'run'])).toEqual(['npm', 'run'])
    expect(stripLeadingEnvTokens(['npm', 'FOO=1'])).toEqual(['npm', 'FOO=1'])
    expect(stripLeadingEnvTokens([])).toEqual([])
  })
})
