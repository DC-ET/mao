import type { ToolCall } from '../types/chat'

/** 工具内部名 → 管理后台展示名（与 desktop/src/utils/toolDisplay.ts 同口径） */
const TOOL_DISPLAY_NAMES: Record<string, string> = {
  glob_search: '搜索文件',
  grep_search: '搜索内容',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  shell: '执行命令',
  ask_user_questions: '询问用户',
  task_create: '创建任务',
  task_update: '更新任务',
  task_list: '查询任务',
  task_delete: '删除任务',
  delegate: '委派子代理',
  web_search: '网页搜索',
  open_web_page: '打开网页',
  generate_image: '生成图片',
  edit_image: '编辑图片',
  send_wechat_image: '发送微信图片',
  send_wechat_file: '发送微信文件',
  create_scheduled_task: '创建定时任务',
  update_scheduled_task: '更新定时任务',
  delete_scheduled_task: '删除定时任务',
  list_scheduled_tasks: '查询定时任务'
}

export function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] || name
}

/** 关键参数预览：命令 / 搜索词 / 文件路径，用于卡片和分组的单行摘要 */
export function toolInputPreview(input?: Record<string, unknown>): string {
  if (!input) return ''
  const cmd = input.command
  if (typeof cmd === 'string') {
    return cmd.slice(0, 60) + (cmd.length > 60 ? '...' : '')
  }
  const pattern = input.pattern
  if (typeof pattern === 'string') {
    const searchPath = input.path
    const suffix = typeof searchPath === 'string' && searchPath ? ` in ${searchPath}` : ''
    const text = `${pattern}${suffix}`
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  const path = input.path ?? input.file_path
  if (typeof path === 'string') return path
  const query = input.query
  if (typeof query === 'string') return query
  return ''
}

/** 卡片单行摘要：后端 summary（含结果摘要）优先，否则用中文工具名 + 参数预览 */
export function toolCallLabel(toolCall: Pick<ToolCall, 'name' | 'summary' | 'input'>): string {
  if (toolCall.summary) return toolCall.summary
  const preview = toolInputPreview(toolCall.input)
  const displayName = toolDisplayName(toolCall.name)
  return preview ? `${displayName} · ${preview}` : displayName
}
