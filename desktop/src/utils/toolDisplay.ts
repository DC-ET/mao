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
  delegate_followup: '追问子代理',
  web_search: '网页搜索',
  open_web_page: '打开网页',
  generate_image: '生成图片',
  send_wechat_image: '发送微信图片',
  send_wechat_file: '发送微信文件',
  create_scheduled_task: '创建定时任务',
  update_scheduled_task: '更新定时任务',
  delete_scheduled_task: '删除定时任务',
  list_scheduled_tasks: '查询定时任务',
}

export function getToolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[name] ?? name
}
