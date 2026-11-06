import { describe, expect, it } from 'vitest'
import { resolveApprovalTitle } from './approvalTitle'

describe('resolveApprovalTitle', () => {
  it('三项静态标题原样返回', () => {
    expect(resolveApprovalTitle('shell')).toBe('命令执行待审批')
    expect(resolveApprovalTitle('write_file')).toBe('文件写入待审批')
    expect(resolveApprovalTitle('edit_file')).toBe('文件编辑待审批')
  })

  it('mcp: 前缀解析为 MCP <server> 待审批（LOCAL 审批链路的 toolName 形态）', () => {
    expect(resolveApprovalTitle('mcp:github')).toBe('MCP github 待审批')
    expect(resolveApprovalTitle('mcp:my-server')).toBe('MCP my-server 待审批')
  })

  it('mcp: 空后缀回落通用标题', () => {
    expect(resolveApprovalTitle('mcp:')).toBe('操作待审批')
  })

  it('未知工具回落「操作待审批」', () => {
    expect(resolveApprovalTitle('custom_tool')).toBe('操作待审批')
    expect(resolveApprovalTitle('')).toBe('操作待审批')
  })
})
