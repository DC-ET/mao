/**
 * 审批卡片标题解析（0.0.468）：titleMap 三项静态标题 + LOCAL 模式 MCP 审批的
 * `mcp:<serverName>` 前缀解析（electron/main.cjs 的 requestToolApproval 以该形态下发，
 * 此前不在表里堆叠卡全部显示「操作待审批」）。抽纯函数便于单测（SFC 内部 const 不可测）。
 */

const titleMap: Record<string, string> = {
  shell: '命令执行待审批',
  write_file: '文件写入待审批',
  edit_file: '文件编辑待审批',
}

export function resolveApprovalTitle(toolName: string): string {
  const mapped = titleMap[toolName]
  if (mapped) return mapped
  if (toolName.startsWith('mcp:')) {
    const server = toolName.slice('mcp:'.length)
    if (server) return `MCP ${server} 待审批`
  }
  return '操作待审批'
}
