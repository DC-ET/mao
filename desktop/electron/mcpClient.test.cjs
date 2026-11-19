'use strict'

// mcpClient：工具名解析、结果格式化、同步失败不抛出（技术方案 2026-11-19 §8）。
// 不连真实 MCP 服务器、不拉起 stdio 子进程：connect 注入失败桩，callTool 只打未连接分支。
const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createMcpRuntime,
  registerMcpIpc,
  parseMcpToolName,
  formatCallToolResult,
  formatMcpContent,
} = require('./mcpClient.cjs')

test('parseMcpToolName：mcp__server__tool 成功；缺前缀 / 缺分隔 / 空段返回 null', () => {
  assert.deepEqual(parseMcpToolName('mcp__srv__tool'), { serverName: 'srv', toolName: 'tool' })
  // serverName 或工具名含 __ 时取第一个分隔
  assert.deepEqual(parseMcpToolName('mcp__srv__tool__more'), { serverName: 'srv', toolName: 'tool__more' })
  assert.equal(parseMcpToolName('read_file'), null)
  assert.equal(parseMcpToolName('mcp__'), null)
  assert.equal(parseMcpToolName('mcp__srv'), null)
  assert.equal(parseMcpToolName('mcp____x'), null)
  assert.equal(parseMcpToolName('mcp__srv__'), null)
  assert.equal(parseMcpToolName(''), null)
  assert.equal(parseMcpToolName(null), null)
})

test('formatCallToolResult：structuredContent 优先序列化', () => {
  const out = formatCallToolResult({ structuredContent: { a: 1, b: 'x' } })
  assert.equal(out, JSON.stringify({ a: 1, b: 'x' }, null, 2))
})

test('formatMcpContent / formatCallToolResult：text、image 占位、resource 拼接', () => {
  const result = {
    content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'abcd', mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///x', text: 'body' } },
    ],
  }
  assert.equal(
    formatCallToolResult(result),
    'hello\n[image data: image/png, 4 chars base64]\n[resource: file:///x]\nbody'
  )
  assert.equal(formatCallToolResult(null), '')
  assert.equal(formatMcpContent(null), '')
  assert.equal(formatMcpContent('plain'), 'plain')
})

test('注入失败的 connect：syncServers 返回 connected:false 且带 error，不抛出', async () => {
  const mcp = createMcpRuntime({
    connect: async () => { throw new Error('boom-connect') },
  })
  const reports = await mcp.syncServers(1, [{ name: 'a', type: 'STDIO', command: 'whatever' }])
  assert.deepEqual(reports, [{ name: 'a', connected: false, tools: [], error: 'boom-connect' }])

  // 成功路径：注入假 connect，tools 原样上报
  const ok = createMcpRuntime({
    connect: async () => ({ client: {}, transport: null, tools: [{ name: 't' }] }),
  })
  const okReports = await ok.syncServers(2, [{ name: 'b' }])
  assert.deepEqual(okReports, [{ name: 'b', connected: true, tools: [{ name: 't' }], error: null }])

  // 缺 name 的 server 被跳过
  const none = createMcpRuntime({ connect: async () => { throw new Error('x') } })
  assert.deepEqual(await none.syncServers(3, [{}]), [])
})

test('callTool：未连接时抛错（不依赖 SDK 连接）', async () => {
  const mcp = createMcpRuntime({ connect: async () => { throw new Error('unused') } })
  await assert.rejects(
    () => mcp.callTool('9', 'nosuch', 'tool', {}),
    /MCP server "nosuch" is not connected/
  )
})

test('closeAll / closeSession：空 Map 上安全不抛出', async () => {
  const mcp = createMcpRuntime()
  await mcp.closeSession(1)
  await mcp.closeAll()
})

test('registerMcpIpc：注册 mcp-sync / mcp-close，返回形状保持', async () => {
  const handlers = {}
  const fakeIpc = { handle: (channel, cb) => { handlers[channel] = cb } }
  const mcp = createMcpRuntime({
    connect: async () => ({ client: {}, transport: null, tools: [] }),
  })
  registerMcpIpc(fakeIpc, mcp)
  assert.deepEqual(Object.keys(handlers).sort(), ['mcp-close', 'mcp-sync'])

  const syncResult = await handlers['mcp-sync'](null, { sessionId: 5, servers: [{ name: 's' }] })
  assert.equal(syncResult.success, true)
  assert.equal(syncResult.reports.length, 1)

  const noSession = await handlers['mcp-sync'](null, {})
  assert.deepEqual(noSession, { success: false, error: 'No sessionId provided for mcp-sync.' })

  const closeResult = await handlers['mcp-close'](null, { sessionId: 5 })
  assert.deepEqual(closeResult, { success: true })
})
