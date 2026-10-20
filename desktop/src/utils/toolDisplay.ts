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
  spawn_subagent: '启动后台子代理',
  subagent_followup: '追问后台子代理',
  check_subagent: '查看后台子代理',
  cancel_subagent: '取消后台子代理',
  wait_subagents: '等待后台子代理',
  web_search: '网页搜索',
  open_web_page: '打开网页',
  generate_image: '生成图片',
  edit_image: '编辑图片',
  feishu_read_doc: '读取飞书文档',
  feishu_download_file: '下载飞书文件',
  feishu_send_image: '发送飞书图片',
  feishu_send_file: '发送飞书文件',
  dingtalk_send_image: '发送钉钉图片',
  dingtalk_send_file: '发送钉钉文件',
  send_wechat_image: '发送微信图片',
  send_wechat_file: '发送微信文件',
  create_scheduled_task: '创建定时任务',
  update_scheduled_task: '更新定时任务',
  delete_scheduled_task: '删除定时任务',
  list_scheduled_tasks: '查询定时任务',
  page_inspect: '查看页面元素',
  page_observe: '观察页面变化',
  page_screenshot: '截取页面截图',
  page_scroll: '滚动页面',
  page_focus: '聚焦页面元素',
  page_fill: '填写页面输入框',
  page_select: '选择下拉选项',
  page_check: '勾选页面控件',
  page_uncheck: '取消勾选页面控件',
  page_click: '点击页面元素',
  page_keyboard: '发送键盘输入',
  page_wait: '等待页面',
  page_actions: '执行批量页面操作',
  mcp_call: '调用 MCP 工具',
  mcp_describe: '查询 MCP 工具参数',
  http_call: '调用自定义工具',
  http_describe: '查询自定义工具参数',
}

export function getToolDisplayName(name: string): string {
  const mapped = TOOL_DISPLAY_NAMES[name]
  if (mapped) return mapped
  // 全量模式 / 历史消息里的工具名是 mcp__server__tool：展示层还原为 server.tool
  if (name.startsWith('mcp__')) {
    const rest = name.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep > 0 && sep + 2 < rest.length) return `${rest.slice(0, sep)}.${rest.slice(sep + 2)}`
  }
  return name
}

export function getToolInputPreview(name: string, input?: Record<string, unknown> | null): string {
  if (!input) return ''
  switch (name) {
    case 'mcp_call':
    case 'mcp_describe': {
      // 流式事件下发的仍是原始工具名 mcp_call，还原在展示层完成：
      // 从外壳 {server, tool, arguments} 取 server.tool，避免卡片显示裸 JSON。
      const server = typeof input.server === 'string' ? input.server : ''
      const tool = typeof input.tool === 'string' ? input.tool : ''
      return server && tool ? `${server}.${tool}` : ''
    }
    case 'http_call':
    case 'http_describe': {
      // 同 mcp 还原思路：外壳 {tool, arguments} 取内层 slug，调用再拼参数摘要
      const tool = typeof input.tool === 'string' ? input.tool : ''
      if (name === 'http_describe') return tool
      const inner = input.arguments
      if (!tool) return ''
      if (inner == null) return tool
      if (typeof inner !== 'object' || Array.isArray(inner)) return tool
      const keys = Object.keys(inner as Record<string, unknown>)
      if (keys.length === 0) return tool
      const summary = keys
        .slice(0, 3)
        .map((key) => {
          const value = (inner as Record<string, unknown>)[key]
          const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
          return `${key}=${text.length > 20 ? `${text.slice(0, 20)}...` : text}`
        })
        .join(', ')
      return `${tool}(${summary}${keys.length > 3 ? ', ...' : ''})`
    }
    case 'generate_image':
    case 'edit_image': {
      const prompt = input.prompt
      if (typeof prompt === 'string' && prompt) return prompt.length > 60 ? prompt.slice(0, 60) + '...' : prompt
      const images = input.image_paths ?? input.image
      if (typeof images === 'string') return images
      if (Array.isArray(images) && typeof images[0] === 'string') return images[0]
      return ''
    }
    case 'feishu_read_doc':
      return typeof input.link === 'string' ? input.link : ''
    case 'feishu_download_file':
      return typeof input.message_id === 'string' ? input.message_id : ''
    case 'feishu_send_image':
      return typeof input.image === 'string' ? input.image : ''
    case 'feishu_send_file':
    case 'dingtalk_send_file':
      if (typeof input.filename === 'string' && input.filename.trim()) return input.filename
      return typeof input.file === 'string' ? input.file : ''
    case 'dingtalk_send_image':
      return typeof input.image === 'string' ? input.image : ''
    case 'page_inspect':
    case 'page_observe':
    case 'page_screenshot':
      return typeof input.reason === 'string' ? input.reason : ''
    case 'page_actions': {
      const actions = Array.isArray(input.actions) ? input.actions : []
      return `${actions.length} 个动作`
    }
    case 'page_fill':
      return typeof input.value === 'string' ? `值: ${input.value.slice(0, 40)}` : ''
    case 'page_select':
      return typeof input.value === 'string' ? `选项: ${input.value}` : ''
    case 'page_keyboard':
      return typeof input.key === 'string' ? `按键: ${input.key}` : ''
    case 'page_scroll':
      return typeof input.to === 'string' ? `滚动到 ${input.to}` : ''
    case 'page_wait':
      return typeof input.ms === 'number' ? `等待 ${input.ms}ms` : ''
    case 'page_click':
    case 'page_focus':
    case 'page_check':
    case 'page_uncheck':
      return typeof input.elementId === 'string' ? `元素: ${input.elementId}` : ''
  }
  const cmd = input.command
  if (typeof cmd === 'string') {
    return cmd.slice(0, 60) + (cmd.length > 60 ? '...' : '')
  }
  const pattern = input.pattern
  if (typeof pattern === 'string') {
    const searchPath = input.path
    const suffix = (typeof searchPath === 'string' && searchPath) ? ` in ${searchPath}` : ''
    const text = `${pattern}${suffix}`
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  const path = input.path ?? input.file_path
  if (typeof path === 'string') return path
  const query = input.query
  if (typeof query === 'string') return query
  // delegate / spawn_subagent 工具：优先展示自定义标题，其次 agent_type + task 摘要。
  // 否则 inputPreview 恒为空，卡片在子代理执行期间一直显示"参数加载中..."
  const agentType = input.agent_type
  const task = input.task
  if (typeof agentType === 'string' || typeof task === 'string') {
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const prefix = typeof agentType === 'string' && agentType ? `${agentType}: ` : ''
    const body = title || (typeof task === 'string' ? task : '')
    const text = prefix + body
    return text.length > 60 ? text.slice(0, 60) + '...' : text
  }
  return ''
}
