import { describe, expect, it } from 'vitest'
import { getToolDisplayName, getToolInputPreview, toolCallLabel } from './toolDisplay'

const feishuCases = [
  { name: 'feishu_download_file', label: '下载飞书文件', key: 'message_id', value: 'om_message' },
  { name: 'feishu_send_image', label: '发送飞书图片', key: 'image', value: 'images/photo.png' },
  { name: 'feishu_send_file', label: '发送飞书文件', key: 'file', value: '/workspace/report.pdf' },
]

const dingtalkCases = [
  { name: 'dingtalk_send_image', label: '发送钉钉图片', key: 'image', value: 'images/photo.png' },
  { name: 'dingtalk_send_file', label: '发送钉钉文件', key: 'file', value: '/workspace/report.pdf' },
]

describe('getToolDisplayName', () => {
  it.each([...feishuCases, ...dingtalkCases])('$name 展示中文名', ({ name, label }) => {
    expect(getToolDisplayName(name)).toBe(label)
  })

  it('保留原有名称和未知工具名', () => {
    expect(getToolDisplayName('read_file')).toBe('读取文件')
    expect(getToolDisplayName('send_wechat_image')).toBe('发送微信图片')
    expect(getToolDisplayName('delegate')).toBe('委派子代理')
    expect(getToolDisplayName('custom_tool')).toBe('custom_tool')
  })

  it('dump_user_messages 展示中文名（曾裸显英文工具名）', () => {
    expect(getToolDisplayName('dump_user_messages')).toBe('导出用户消息')
  })

  it('后台子代理系列展示中文名', () => {
    expect(getToolDisplayName('spawn_subagent')).toBe('启动后台子代理')
    expect(getToolDisplayName('subagent_followup')).toBe('追问后台子代理')
    expect(getToolDisplayName('check_subagent')).toBe('查看后台子代理')
    expect(getToolDisplayName('cancel_subagent')).toBe('取消后台子代理')
    expect(getToolDisplayName('wait_subagents')).toBe('等待后台子代理')
  })

  it('MCP / 自定义工具与页面工具展示中文名', () => {
    expect(getToolDisplayName('mcp_call')).toBe('调用 MCP 工具')
    expect(getToolDisplayName('http_call')).toBe('调用自定义工具')
    expect(getToolDisplayName('page_inspect')).toBe('查看页面元素')
    expect(getToolDisplayName('page_click')).toBe('点击页面元素')
  })

  it('mcp__server__tool 还原为 server.tool', () => {
    expect(getToolDisplayName('mcp__github__create_issue')).toBe('github.create_issue')
    // 非法形态保持原样，不误还原
    expect(getToolDisplayName('mcp__')).toBe('mcp__')
    expect(getToolDisplayName('mcp__server')).toBe('mcp__server')
    expect(getToolDisplayName('mcp____tool')).toBe('mcp____tool')
  })
})

describe('getToolInputPreview', () => {
  it.each([...feishuCases, ...dingtalkCases])('$name 使用真实参数', ({ name, key, value }) => {
    expect(getToolInputPreview(name, { [key]: value })).toBe(value)
    expect(getToolInputPreview(name)).toBe('')
    expect(getToolInputPreview(name, null)).toBe('')
    expect(getToolInputPreview(name, {})).toBe('')
    for (const invalid of [null, 42, {}, []]) {
      expect(getToolInputPreview(name, { [key]: invalid })).toBe('')
    }
  })

  it('发送图片和文件支持 URL', () => {
    const url = 'https://example.com/media'
    expect(getToolInputPreview('feishu_send_image', { image: url })).toBe(url)
    expect(getToolInputPreview('feishu_send_file', { file: url })).toBe(url)
  })

  it('发送文件优先展示 filename，没有有效文件名时展示 file', () => {
    expect(getToolInputPreview('feishu_send_file', { file: '/tmp/a.pdf', filename: '报告.pdf' })).toBe('报告.pdf')
    for (const filename of [undefined, null, '', '  ', 42]) {
      expect(getToolInputPreview('feishu_send_file', { file: '/tmp/a.pdf', filename })).toBe('/tmp/a.pdf')
    }
  })

  it('不会将飞书专用字段应用于其他工具', () => {
    expect(getToolInputPreview('custom_tool', { link: 'link', message_id: 'om_id', image: 'a.png', file: 'a.pdf', filename: '报告.pdf' })).toBe('')
  })

  it('dump_user_messages 预览导出的消息条数（缺省或非正数不展示）', () => {
    expect(getToolInputPreview('dump_user_messages', { recentCount: 3 })).toBe('最近 3 条')
    expect(getToolInputPreview('dump_user_messages', { recentCount: '2' })).toBe('最近 2 条')
    for (const invalid of [undefined, null, '', 'abc', 0, -1, {}]) {
      expect(getToolInputPreview('dump_user_messages', { recentCount: invalid })).toBe('')
    }
  })

  it('mcp_call / mcp_describe 从外壳还原 server.tool', () => {
    expect(getToolInputPreview('mcp_call', { server: 'github', tool: 'create_issue', arguments: { title: 'x' } })).toBe('github.create_issue')
    expect(getToolInputPreview('mcp_describe', { server: 'github', tool: 'create_issue' })).toBe('github.create_issue')
    expect(getToolInputPreview('mcp_call', { tool: 'create_issue' })).toBe('')
    expect(getToolInputPreview('mcp_call', { server: 'github' })).toBe('')
  })

  it('http_call 拼装内层参数摘要，http_describe 只展示 slug', () => {
    expect(getToolInputPreview('http_describe', { tool: 'weather' })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather' })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: null })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: { city: '北京', days: 3 } })).toBe('weather(city=北京, days=3)')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: {} })).toBe('weather')
    expect(getToolInputPreview('http_call', { arguments: { city: '北京' } })).toBe('')
  })

  it('页面工具展示中文参数预览', () => {
    expect(getToolInputPreview('page_click', { snapshotId: 's1', elementId: 'e3' })).toBe('元素: e3')
    expect(getToolInputPreview('page_fill', { elementId: 'e1', value: '张三' })).toBe('值: 张三')
    expect(getToolInputPreview('page_select', { value: 'b' })).toBe('选项: b')
    expect(getToolInputPreview('page_inspect', { includeHidden: true })).toBe('包含隐藏元素')
    expect(getToolInputPreview('page_inspect', {})).toBe('')
    expect(getToolInputPreview('page_actions', { actions: [{}, {}] })).toBe('2 个动作')
    expect(getToolInputPreview('page_wait', { ms: 500 })).toBe('等待 500ms')
  })

  it.each([
    { input: undefined, expected: '' },
    { input: null, expected: '' },
    { input: {}, expected: '' },
    { input: { command: 'pwd', pattern: '*', path: '/tmp' }, expected: 'pwd' },
    { input: { command: '', path: '/tmp' }, expected: '' },
    { input: { pattern: '*.ts', path: 'src' }, expected: '*.ts in src' },
    { input: { pattern: '*.ts', path: '' }, expected: '*.ts' },
    { input: { pattern: '*.ts', path: 42 }, expected: '*.ts' },
    { input: { path: '/tmp/a', file_path: '/tmp/b', query: 'query' }, expected: '/tmp/a' },
    { input: { file_path: '/tmp/b' }, expected: '/tmp/b' },
    { input: { path: null, file_path: '/tmp/b' }, expected: '/tmp/b' },
    { input: { path: '', file_path: '/tmp/b' }, expected: '' },
    { input: { path: 42, file_path: '/tmp/b' }, expected: '' },
    { input: { query: 'query', task: 'task' }, expected: 'query' },
    { input: { agent_type: 'worker', task: '修复问题' }, expected: 'worker: 修复问题' },
    { input: { agent_type: 'worker', task: '修复问题', title: '修复登录鉴权' }, expected: 'worker: 修复登录鉴权' },
    { input: { agent_type: 'worker', task: '修复问题', title: '   ' }, expected: 'worker: 修复问题' },
    { input: { agent_type: 'worker' }, expected: 'worker: ' },
    { input: { task: '修复问题' }, expected: '修复问题' },
    { input: { agent_type: '', task: '修复问题' }, expected: '修复问题' },
    { input: { command: 42, pattern: {}, path: [], query: false, agent_type: null, task: 42 }, expected: '' },
  ])('保留通用预览逻辑：$input', ({ input, expected }) => {
    expect(getToolInputPreview('custom_tool', input)).toBe(expected)
  })

  it('保留命令、搜索和委派的 60 字符截断边界', () => {
    for (const length of [60, 61]) {
      const text = 'a'.repeat(length)
      const expected = length > 60 ? text.slice(0, 60) + '...' : text
      expect(getToolInputPreview('shell', { command: text })).toBe(expected)
      expect(getToolInputPreview('glob_search', { pattern: text })).toBe(expected)
      expect(getToolInputPreview('delegate', { task: text })).toBe(expected)
    }
    const text = 'a'.repeat(55) + ' in src'
    expect(getToolInputPreview('grep_search', { pattern: 'a'.repeat(55), path: 'src' })).toBe(text.slice(0, 60) + '...')
    expect(getToolInputPreview('delegate', { agent_type: 'worker', task: 'a'.repeat(60) })).toBe(('worker: ' + 'a'.repeat(60)).slice(0, 60) + '...')
  })

  it('保留路径与查询不截断的行为', () => {
    const text = 'a'.repeat(100)
    expect(getToolInputPreview('read_file', { path: text })).toBe(text)
    expect(getToolInputPreview('read_file', { file_path: text })).toBe(text)
    expect(getToolInputPreview('web_search', { query: text })).toBe(text)
  })
})

describe('toolCallLabel', () => {
  const base = { id: 'tc1', status: 'success', isExpanded: false } as const

  it('后端 summary 优先', () => {
    expect(toolCallLabel({ ...base, name: 'dump_user_messages', summary: '后端摘要', input: { recentCount: 3 } })).toBe('后端摘要')
  })

  it('无 summary 时用中文工具名 + 参数预览', () => {
    expect(toolCallLabel({ ...base, name: 'dump_user_messages', input: { recentCount: 3 } })).toBe('导出用户消息 · 最近 3 条')
    expect(toolCallLabel({ ...base, name: 'shell', input: { command: 'pwd' } })).toBe('执行命令 · pwd')
  })

  it('无参数预览时只展示中文工具名', () => {
    expect(toolCallLabel({ ...base, name: 'dump_user_messages', input: {} })).toBe('导出用户消息')
    expect(toolCallLabel({ ...base, name: 'unknown_tool' })).toBe('unknown_tool')
  })
})
