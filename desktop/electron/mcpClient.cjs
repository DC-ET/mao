'use strict'

// MCP 客户端运行时（自 main.cjs 抽出，技术方案 2026-11-19 §5.4）。
// LOCAL 模式下桌面端作为 MCP 客户端代理：服务端下发 mcp_sync_required，主进程用官方
// Node SDK 建立连接并上报工具清单；工具执行走 tool-execute 委托（审批留在入口 handleMcpToolFromWebSocket）。
// session → server 连接 Map 只住在本模块，入口通过 createMcpRuntime() 返回的方法读写（D8）。

const { Client: McpClient } = require('@modelcontextprotocol/sdk/client')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js')

const MCP_TOOL_PREFIX = 'mcp__'
const MCP_CALL_TIMEOUT_MS = 120000

/**
 * sessionId -> serverName -> { client, transport, tools }
 * @type {Map<number, Map<string, {client: import('@modelcontextprotocol/sdk/client').Client, transport: any, tools: Array}>>}
 */
const mcpClients = new Map()

function mcpServerKey(serverName) {
  return String(serverName || '')
}

/** 解析 mcp__{serverName}__{toolName}，非法名返回 null */
function parseMcpToolName(toolName) {
  if (!toolName || !toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const serverName = rest.slice(0, sep)
  const innerName = rest.slice(sep + 2)
  if (!serverName || !innerName) return null
  return { serverName, toolName: innerName }
}

async function connectMcpServer(sessionId, server) {
  const { name, type, command, args, url, env } = server || {}
  if (!name) throw new Error('MCP server missing name')

  let transport
  if (type === 'STDIO') {
    if (!command) throw new Error(`MCP server "${name}": STDIO requires command`)
    // 合并默认安全环境（PATH/HOME 等），再叠加管理员配置的环境变量
    const mergedEnv = { ...getDefaultEnvironment() }
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        if (v != null) mergedEnv[k] = String(v)
      }
    }
    transport = new StdioClientTransport({
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      env: mergedEnv,
      stderr: 'pipe'
    })
  } else if (type === 'HTTP') {
    if (!url) throw new Error(`MCP server "${name}": HTTP requires url`)
    transport = new StreamableHTTPClientTransport(new URL(url))
  } else {
    throw new Error(`MCP server "${name}": unsupported type "${type}"`)
  }

  const client = new McpClient({ name: 'mao-desktop', version: require('../package.json').version || '1.0.0' })
  await client.connect(transport)
  const list = await client.listTools()
  const tools = (list.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
    // 透传 MCP 标准注解：服务端工作集用它标注 [只读]、审批据此对明确只读的工具免审。
    annotations: t.annotations || null
  }))
  return { client, transport, tools }
}

async function closeMcpSession(sessionId) {
  const connections = mcpClients.get(Number(sessionId))
  if (!connections) return
  mcpClients.delete(Number(sessionId))
  const names = Array.from(connections.keys())
  await Promise.allSettled(names.map(async (serverName) => {
    try {
      const conn = connections.get(serverName)
      if (conn?.client) {
        await conn.client.close()
      }
    } catch (e) {
      console.warn(`[mcp] close failed for ${serverName}:`, e.message)
    }
  }))
  console.log(`[mcp] closed ${names.length} connection(s) for session ${sessionId}`)
}

/**
 * 将 MCP CallToolResult 转为文本（与后端 Java McpClientManager.formatResult 语义一致）：
 * - 顶层 structuredContent 非空时优先序列化输出（结构化数据更利于模型理解）；
 * - 否则拼接 content 中的文本/图片/资源内容。
 */
function formatCallToolResult(result) {
  if (!result) return ''
  if (result.structuredContent != null) {
    try { return JSON.stringify(result.structuredContent, null, 2) } catch { /* fallthrough */ }
  }
  return formatMcpContent(result.content)
}

function formatMcpContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  const parts = []
  for (const item of content) {
    if (!item) continue
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item.type === 'image' && item.data) {
      parts.push(`[image data: ${item.mimeType || 'unknown'}, ${item.data.length} chars base64]`)
    } else if (item.type === 'resource' && item.resource) {
      parts.push(`[resource: ${item.resource.uri || ''}]\n${item.resource.text || ''}`)
    } else if (item.structuredContent != null) {
      try { parts.push(JSON.stringify(item.structuredContent, null, 2)) } catch { /* ignore */ }
    } else {
      try { parts.push(JSON.stringify(item)) } catch { /* ignore */ }
    }
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * deps.connect 可注入（单测不连真实服务器、不拉起 stdio 子进程）；默认走官方 SDK 连接。
 */
function createMcpRuntime(deps = {}) {
  const connectImpl = deps.connect || connectMcpServer

  async function syncMcpServers(sessionId, servers) {
    const sid = Number(sessionId)
    // 先清理旧连接，避免重复同步时泄漏
    await closeMcpSession(sid)

    const connections = new Map()
    mcpClients.set(sid, connections)

    const reports = []
    for (const server of servers || []) {
      const name = server?.name
      if (!name) continue
      try {
        const conn = await connectImpl(sid, server)
        connections.set(mcpServerKey(name), conn)
        reports.push({ name, connected: true, tools: conn.tools, error: null })
        console.log(`[mcp] connected server "${name}" for session ${sid}, ${conn.tools.length} tool(s)`)
      } catch (e) {
        console.warn(`[mcp] connect failed for "${name}" (session ${sid}):`, e.message)
        reports.push({ name, connected: false, tools: [], error: e.message })
      }
    }
    return reports
  }

  async function callMcpTool(sessionId, serverName, toolName, args) {
    const sid = Number(sessionId)
    const connections = mcpClients.get(sid)
    const conn = connections && connections.get(mcpServerKey(serverName))
    if (!conn?.client) {
      throw new Error(`MCP server "${serverName}" is not connected (session ${sid}). Re-run the session to re-sync MCP servers.`)
    }
    const timer = setTimeout(() => {
      console.warn(`[mcp] call ${serverName}.${toolName} timed out after ${MCP_CALL_TIMEOUT_MS}ms`)
    }, MCP_CALL_TIMEOUT_MS)
    try {
      const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: MCP_CALL_TIMEOUT_MS
      })
      if (result?.isError) {
        throw new Error(formatCallToolResult(result) || `MCP tool ${serverName}.${toolName} returned an error`)
      }
      // 传入完整 result，保留顶层 structuredContent（部分服务器主要或仅返回该字段）
      return formatCallToolResult(result)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 关闭全部会话的连接（切服务器 / before-quit 用；逐会话 catch，不因单会话失败中断） */
  async function closeAll() {
    const sessionIds = Array.from(mcpClients.keys())
    await Promise.all(
      sessionIds.map((sid) =>
        closeMcpSession(sid).catch((e) => console.warn('[mcp] closeAll failed:', e?.message))
      )
    )
  }

  return {
    syncServers: syncMcpServers,
    closeSession: closeMcpSession,
    closeAll,
    callTool: callMcpTool,
    parseToolName: parseMcpToolName,
  }
}

function registerMcpIpc(ipcMain, mcp) {
  ipcMain.handle('mcp-sync', async (event, { sessionId, servers }) => {
    if (!sessionId) return { success: false, error: 'No sessionId provided for mcp-sync.' }
    try {
      const reports = await mcp.syncServers(sessionId, servers || [])
      return { success: true, reports }
    } catch (e) {
      console.error('[mcp] mcp-sync failed:', e)
      return { success: false, error: e.message, reports: [] }
    }
  })

  ipcMain.handle('mcp-close', async (event, { sessionId }) => {
    try {
      await mcp.closeSession(Number(sessionId))
      return { success: true }
    } catch (e) {
      return { success: false, error: e.message }
    }
  })
}

module.exports = {
  createMcpRuntime,
  registerMcpIpc,
  parseMcpToolName,
  formatCallToolResult,
  formatMcpContent,
  MCP_TOOL_PREFIX,
  MCP_CALL_TIMEOUT_MS,
}
