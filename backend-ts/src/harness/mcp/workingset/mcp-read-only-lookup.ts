import type { SessionMapper } from '../../deps.js';
import type { McpSessionToolsLookup } from './impl/mcp-call-tool.js';
import type { McpLoadModeResolver } from './mcp-load-mode.js';

/**
 * MCP 只读免审查询（技术方案 2026-10-18 §5.6 / §5.7）。
 *
 * 只有「工作集模式」才消费 readOnlyHint：
 * - 工作集模式没有逐工具 schema，明确只读的工具在 READ_ONLY / READ_WRITE 级免审是配套收益；
 * - 全量注入是「旧行为」开关，必须保持改造前「MCP 一律审批」的语义，不能因为多了注解而放宽。
 *
 * 解析器每轮 buildContext 已经解析过模式（5s TTL 缓存），这里再查一次会话用户即可命中缓存。
 */
export function createMcpReadOnlyLookup(deps: {
  sessionMapper: Pick<SessionMapper, 'selectById'>;
  loadModeResolver: Pick<McpLoadModeResolver, 'resolve'>;
  toolsRegistry: McpSessionToolsLookup;
}): (sessionId: number | null, fullToolName: string) => Promise<boolean> {
  return async (sessionId, fullToolName) => {
    if (sessionId == null) return false;
    let mode: Awaited<ReturnType<McpLoadModeResolver['resolve']>>;
    try {
      const session = await deps.sessionMapper.selectById(sessionId);
      if (session == null) return false;
      mode = await deps.loadModeResolver.resolve(session.userId ?? null);
    } catch {
      // 解析失败按全量模式的保守口径：不因注解放宽审批
      return false;
    }
    if (mode !== 'working_set') return false;
    return deps.toolsRegistry.getSessionTools(sessionId).some((ref) =>
      (ref.fullToolName ?? `mcp__${ref.serverName}__${ref.toolName}`) === fullToolName
      && ref.annotations?.readOnlyHint === true);
  };
}
