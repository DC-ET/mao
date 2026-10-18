import type { McpConnectionError, McpServer, McpToolRef } from '../entity/mcp-server.js';

/**
 * 工作集结构化数据（技术方案 2026-10-18 §5.2 / §5.3）。
 *
 * 本文件只负责「取哪些 server / tool、如何排序、是否只读、是否不可用」，
 * 提示词文案由 PromptEngine 渲染——文案调整不触碰数据层，纯函数也便于单测。
 */
export interface McpWorkingSetTool {
  name: string;
  /** MCP annotations.readOnlyHint === true；未标注一律 false（保守视同可写）。 */
  readOnly: boolean;
}

export interface McpWorkingSetServer {
  name: string;
  description: string;
  tools: McpWorkingSetTool[];
  /** 明确标注为只读的工具数；无任何 annotations 时为 0。 */
  readOnlyCount: number;
  /** 其余工具数（含未标注的）。 */
  writeCount: number;
  /** 是否有任何工具带 annotations：无注解信息时标题不显示只读 / 可写计数。 */
  hasAnnotations: boolean;
  /** 非 null 表示该 server 本轮不可用（连接失败 / 被取消）。 */
  unavailableReason: string | null;
}

export interface McpWorkingSet {
  servers: McpWorkingSetServer[];
}

/**
 * 生成工作集（确定性输出，前缀缓存前提）：
 * - server 按 (name, id) 排序，工具按 name 排序；
 * - 同一 (serverName, toolName) 重复出现时只保留第一个；
 * - 连接失败的 server 仍列出并标注原因，不静默消失（§2.2）；
 * - 没有任何 server 时返回空结构（调用方据此不渲染 section、不注入工具）。
 */
export function buildMcpWorkingSet(
  servers: McpServer[],
  tools: McpToolRef[],
  connectionErrors: McpConnectionError[] = [],
): McpWorkingSet {
  const sortedServers = [...servers].sort((a, b) => {
    const an = a.name ?? '';
    const bn = b.name ?? '';
    if (an !== bn) return an < bn ? -1 : 1;
    return (a.id ?? 0) - (b.id ?? 0);
  });

  const toolsByServerId = new Map<number, McpToolRef[]>();
  const toolsByServerName = new Map<string, McpToolRef[]>();
  for (const tool of tools) {
    if (tool.serverId > 0) {
      const list = toolsByServerId.get(tool.serverId) ?? [];
      list.push(tool);
      toolsByServerId.set(tool.serverId, list);
    }
    const named = toolsByServerName.get(tool.serverName) ?? [];
    named.push(tool);
    toolsByServerName.set(tool.serverName, named);
  }

  const result: McpWorkingSet = { servers: [] };
  for (const server of sortedServers) {
    const name = server.name ?? '';
    if (name.trim() === '') continue;
    // serverId 优先；LOCAL 上报里 serverId 缺失（0）时退化为按名字取。
    const source = server.id != null && server.id > 0
      ? (toolsByServerId.get(server.id) ?? toolsByServerName.get(name) ?? [])
      : (toolsByServerName.get(name) ?? []);
    const { tools: deduped, hasAnnotations } = dedupeAndSortTools(source);
    const readOnlyCount = deduped.filter((t) => t.readOnly).length;
    result.servers.push({
      name,
      description: (server.description ?? '').trim(),
      tools: deduped,
      readOnlyCount,
      writeCount: deduped.length - readOnlyCount,
      hasAnnotations,
      unavailableReason: resolveUnavailableReason(server, connectionErrors),
    });
  }
  return result;
}

function dedupeAndSortTools(tools: McpToolRef[]): { tools: McpWorkingSetTool[]; hasAnnotations: boolean } {
  const seen = new Set<string>();
  const deduped: McpWorkingSetTool[] = [];
  let hasAnnotations = false;
  for (const tool of tools) {
    if (tool.toolName.trim() === '' || seen.has(tool.toolName)) continue;
    seen.add(tool.toolName);
    // 只以「最终保留的那一条」判断注解，避免重复项中带注解的那条被去重掉后仍显示计数
    if (tool.annotations != null) hasAnnotations = true;
    deduped.push({ name: tool.toolName, readOnly: tool.annotations?.readOnlyHint === true });
  }
  deduped.sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
  return { tools: deduped, hasAnnotations };
}

/** serverId 优先匹配；缺失时按名称匹配（同名多台时取第一条原因，与清单展示口径一致）。 */
function resolveUnavailableReason(
  server: McpServer,
  connectionErrors: McpConnectionError[],
): string | null {
  if (connectionErrors.length === 0) return null;
  if (server.id != null && server.id > 0) {
    const byId = connectionErrors.find((error) => error.serverId === server.id);
    if (byId != null) return byId.reason;
  }
  const byName = connectionErrors.find((error) => error.serverName === (server.name ?? ''));
  return byName?.reason ?? null;
}
