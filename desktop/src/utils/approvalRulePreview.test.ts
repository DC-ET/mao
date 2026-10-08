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

  it('MCP_TOOL 预览不按 200 截断（后端 MCP_TOOL_NAME_MAX_LENGTH=200 会截断，仅边界不一致）', () => {
    // 后端 normalizeUserInput 对 MCP_TOOL 是 trim + slice(0, 200)：输入超过 200 字符时预览会比实际落库值长。
    // el-input maxlength=512 使 201..512 字符可达；常规 MCP 工具全名远短于 200，属可接受的边界差异。
    const longName = 'mcp__' + 'a'.repeat(300)
    const preview = previewRuleValue('MCP_TOOL', longName)
    const backendSaved = longName.trim().slice(0, 200)
    expect(preview.length).toBe(longName.length)
    expect(backendSaved.length).toBe(200)
  })

  it('SHELL_PREFIX 单 token 与多空白口径', () => {
    expect(previewRuleValue('SHELL_PREFIX', 'ls')).toBe('ls')
    expect(previewRuleValue('SHELL_PREFIX', '  npm   run  build ')).toBe('npm run')
    expect(previewRuleValue('SHELL_PREFIX', 'FOO=1 npm run FOO=2 build')).toBe('npm run')
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
