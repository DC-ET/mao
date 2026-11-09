import { describe, expect, it } from 'vitest'
import { getToolDisplayName, getToolInputPreview } from './toolDisplay'

const dingtalkCases = [
  { name: 'dingtalk_send_image', label: '发送钉钉图片', key: 'image', value: 'images/photo.png' },
  { name: 'dingtalk_send_file', label: '发送钉钉文件', key: 'file', value: '/workspace/report.pdf' },
]

const feishuCases = [
  { name: 'feishu_download_file', label: '下载飞书文件', key: 'message_id', value: 'om_message' },
  { name: 'feishu_send_image', label: '发送飞书图片', key: 'image', value: 'images/photo.png' },
  { name: 'feishu_send_file', label: '发送飞书文件', key: 'file', value: '/workspace/report.pdf' },
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

  it('dump_user_messages 展示中文名', () => {
    expect(getToolDisplayName('dump_user_messages')).toBe('导出用户消息')
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

  it('页面工具展示中文名与参数预览', () => {
    expect(getToolDisplayName('page_inspect')).toBe('查看页面元素')
    expect(getToolDisplayName('page_click')).toBe('点击页面元素')
    expect(getToolDisplayName('page_screenshot')).toBe('截取页面截图')
    expect(getToolInputPreview('page_click', { snapshotId: 's1', elementId: 'e3' })).toBe('元素: e3')
    expect(getToolInputPreview('page_fill', { elementId: 'e1', value: '张三' })).toBe('值: 张三')
    expect(getToolInputPreview('page_select', { value: 'b' })).toBe('选项: b')
    expect(getToolInputPreview('page_keyboard', { key: 'Enter' })).toBe('按键: Enter')
    expect(getToolInputPreview('page_scroll', { to: 'bottom' })).toBe('滚动到 bottom')
    expect(getToolInputPreview('page_wait', { ms: 500 })).toBe('等待 500ms')
    expect(getToolInputPreview('page_actions', { actions: [{ type: 'click' }, { type: 'wait' }] })).toBe('2 个动作')
  })

  it('自定义 HTTP 工具展示中文名', () => {
    expect(getToolDisplayName('http_call')).toBe('调用自定义工具')
    expect(getToolDisplayName('http_describe')).toBe('查询自定义工具参数')
  })

  it('http_describe 只回显内层 slug', () => {
    expect(getToolInputPreview('http_describe', { tool: 'weather' })).toBe('weather')
    expect(getToolInputPreview('http_describe', { tool: 'weather', arguments: { city: '上海' } })).toBe('weather')
  })

  it('http_call 回显内层 slug 与参数摘要', () => {
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: { city: '上海' } })).toBe('weather(city=上海)')
    expect(getToolInputPreview('http_call', { tool: 'weather' })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: {} })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: { city: '上海', days: 3, unit: 'c', extra: true } })).toBe('weather(city=上海, days=3, unit=c, ...)')
  })

  it('http_call 参数缺失或非法时只回显 slug', () => {
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: '上海' })).toBe('weather')
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: [1, 2] })).toBe('weather')
    expect(getToolInputPreview('http_call', { arguments: { city: '上海' } })).toBe('')
    expect(getToolInputPreview('http_call', { tool: 42 })).toBe('')
  })

  it('http_call 超长参数值截断到 20 字符', () => {
    expect(getToolInputPreview('http_call', { tool: 'weather', arguments: { city: '上'.repeat(30) } })).toBe(`weather(city=${'上'.repeat(20)}...)`)
  })
})

describe('getToolInputPreview 子代理与定时任务/微信补全（0.0.468）', () => {
  it('check_subagent / cancel_subagent 按任务号展示', () => {
    expect(getToolInputPreview('check_subagent', { task_id: 3 })).toBe('任务 #3')
    expect(getToolInputPreview('cancel_subagent', { task_id: 12 })).toBe('任务 #12')
    // check 无 task_id = 列出全部，无可展示
    expect(getToolInputPreview('check_subagent', {})).toBe('')
    // 数值键非法类型/非法值回落空串
    for (const bad of ['3', 0, -1, 1.5, null, true]) {
      expect(getToolInputPreview('check_subagent', { task_id: bad as unknown as number })).toBe('')
      expect(getToolInputPreview('cancel_subagent', { task_id: bad as unknown as number })).toBe('')
    }
  })

  it('create_scheduled_task 截 30 字符展示 name', () => {
    expect(getToolInputPreview('create_scheduled_task', { name: '日报生成' })).toBe('日报生成')
    expect(getToolInputPreview('create_scheduled_task', { name: '长'.repeat(35) })).toBe('长'.repeat(30) + '...')
    for (const bad of [null, 42, {}, '', '   ']) {
      expect(getToolInputPreview('create_scheduled_task', { name: bad as unknown as string })).toBe('')
    }
  })

  it('update_scheduled_task name 优先，否则任务号兜底；delete_scheduled_task 按任务号', () => {
    expect(getToolInputPreview('update_scheduled_task', { name: '日报生成', task_id: 5 })).toBe('日报生成')
    expect(getToolInputPreview('update_scheduled_task', { task_id: 5 })).toBe('任务 #5')
    expect(getToolInputPreview('update_scheduled_task', {})).toBe('')
    expect(getToolInputPreview('delete_scheduled_task', { task_id: 8 })).toBe('任务 #8')
    expect(getToolInputPreview('delete_scheduled_task', { task_id: '8' })).toBe('')
    expect(getToolInputPreview('delete_scheduled_task', {})).toBe('')
  })

  it('send_wechat_image / send_wechat_file 与飞书同口径', () => {
    expect(getToolInputPreview('send_wechat_image', { image: 'images/photo.png' })).toBe('images/photo.png')
    expect(getToolInputPreview('send_wechat_image', { image: 42 })).toBe('')
    expect(getToolInputPreview('send_wechat_file', { file: '/tmp/a.pdf', file_name: '报告.pdf' })).toBe('报告.pdf')
    expect(getToolInputPreview('send_wechat_file', { file: '/tmp/a.pdf' })).toBe('/tmp/a.pdf')
    expect(getToolInputPreview('send_wechat_file', { file_name: '   ' })).toBe('')
    expect(getToolInputPreview('send_wechat_file', {})).toBe('')
  })

  it('subagent_followup 依赖通用回落（task 键），不被新 case 拦截', () => {
    expect(getToolInputPreview('subagent_followup', { child_session_id: 9, task: '继续分析日志' })).toBe('继续分析日志')
    expect(getToolInputPreview('subagent_followup', { child_session_id: 9, task: '继续分析日志', agent_type: 'explore' })).toBe('explore: 继续分析日志')
  })

  it('list_scheduled_tasks / wait_subagents 不加 case，走通用回落', () => {
    expect(getToolInputPreview('list_scheduled_tasks', {})).toBe('')
    expect(getToolInputPreview('wait_subagents', { timeout_seconds: 60 })).toBe('')
  })
})

describe('BUG-7：码点安全截断（docs/code-review/2026-11-10-logic-bug-audit-01.md）', () => {
  const LONE_HIGH = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
  const LONE_LOW = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

  function assertNoLoneSurrogate(text: string): void {
    expect(LONE_HIGH.test(text)).toBe(false)
    expect(LONE_LOW.test(text)).toBe(false)
  }

  it('generate_image 预览截断不把 emoji 从代理对中间切开', () => {
    // 😀 恰落在切点上（UTF-16 下标 59/60 是一对）：旧实现 slice(0,60) 留下孤立高位代理，渲染成 U+FFFD
    const preview = getToolInputPreview('generate_image', { prompt: 'x'.repeat(59) + '😀' + 'y'.repeat(10) })
    expect(preview.endsWith('...')).toBe(true)
    assertNoLoneSurrogate(preview.replace(/\.{3}$/, ''))
    // emoji 整体落在切点内时完整保留且不产生孤立代理项
    const preview2 = getToolInputPreview('generate_image', { prompt: 'x'.repeat(58) + '😀' + 'y'.repeat(20) })
    assertNoLoneSurrogate(preview2.replace(/\.{3}$/, ''))
    expect(preview2.replace(/\.{3}$/, '')).toContain('😀')
  })

  it('截断长度语义不变：≤ 上限原样返回，> 上限按码点截到上限内', () => {
    expect(getToolInputPreview('generate_image', { prompt: 'a'.repeat(60) })).toBe('a'.repeat(60))
    expect(getToolInputPreview('generate_image', { prompt: 'a'.repeat(61) })).toBe('a'.repeat(60) + '...')
    expect(getToolInputPreview('shell', { command: 'b'.repeat(59) + '😀' + 'c'.repeat(5) }).replace(/\.{3}$/, ''))
      .not.toMatch(LONE_HIGH)
  })
})
