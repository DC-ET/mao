import { describe, expect, it } from 'vitest'
import { getToolDisplayName, getToolInputPreview } from './toolDisplay'

const feishuCases = [
  { name: 'feishu_read_doc', label: '读取飞书文档', key: 'link', value: 'https://example.feishu.cn/wiki/doc' },
  { name: 'feishu_download_file', label: '下载飞书文件', key: 'message_id', value: 'om_message' },
  { name: 'feishu_send_image', label: '发送飞书图片', key: 'image', value: 'images/photo.png' },
  { name: 'feishu_send_file', label: '发送飞书文件', key: 'file', value: '/workspace/report.pdf' },
]

describe('getToolDisplayName', () => {
  it.each(feishuCases)('$name 展示中文名', ({ name, label }) => {
    expect(getToolDisplayName(name)).toBe(label)
  })

  it('保留原有名称和未知工具名', () => {
    expect(getToolDisplayName('read_file')).toBe('读取文件')
    expect(getToolDisplayName('send_wechat_image')).toBe('发送微信图片')
    expect(getToolDisplayName('delegate')).toBe('委派子代理')
    expect(getToolDisplayName('custom_tool')).toBe('custom_tool')
  })
})

describe('getToolInputPreview', () => {
  it.each(feishuCases)('$name 使用真实参数', ({ name, key, value }) => {
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
    { input: { agent_type: 'coder', task: '修复问题' }, expected: 'coder: 修复问题' },
    { input: { agent_type: 'coder' }, expected: 'coder: ' },
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
    expect(getToolInputPreview('delegate', { agent_type: 'coder', task: 'a'.repeat(60) })).toBe(('coder: ' + 'a'.repeat(60)).slice(0, 60) + '...')
  })

  it('保留路径与查询不截断的行为', () => {
    const text = 'a'.repeat(100)
    expect(getToolInputPreview('read_file', { path: text })).toBe(text)
    expect(getToolInputPreview('read_file', { file_path: text })).toBe(text)
    expect(getToolInputPreview('web_search', { query: text })).toBe(text)
  })
})
