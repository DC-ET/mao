import type { FastifyInstance } from 'fastify';
import { hasText } from '../common/case.js';
import { requireUserId, sendOk } from '../common/http-error.js';
import type { AgentService } from '../agent/agent.service.js';
import { EMBED_AGENT_ID_KEY, type SystemSettingService } from '../settings/settings.service.js';

export interface EmbedRouteDeps {
  systemSettingService: SystemSettingService;
  agentService: AgentService;
}

/** GET /v1/embed/admin-config 响应：浮窗助手最终使用的 Agent ID；null 时前端不初始化浮窗。 */
export interface EmbedAdminConfigVO {
  agentId: number | null;
}

/**
 * 管理后台浮窗助手（Web Embed SDK）只读配置：仅要求登录，不查 settings:read——浮窗全员可用。
 * 响应只含 agentId，不透出任何其他配置内容。
 */
export function registerEmbedRoutes(app: FastifyInstance, deps: EmbedRouteDeps): void {
  const { systemSettingService, agentService } = deps;

  app.get('/v1/embed/admin-config', async (request, reply) => {
    requireUserId(request);
    const agentId = await resolveEmbedAgentId(systemSettingService, agentService);
    const vo: EmbedAdminConfigVO = { agentId };
    return sendOk(reply, vo);
  });
}

/**
 * 解析浮窗助手 Agent：配置优先（非数字 / 不存在 / 已停用一律回落系统默认 Agent，不抛错——
 * 浮窗不可用不该让后台接口报错）；未配置时回落系统默认 Agent；默认 Agent 也不可用时返回 null。
 * 回落写法复刻 weixin/session.service.ts resolveWeixinAgent()，不发明第二套解析规则。
 */
export async function resolveEmbedAgentId(
  systemSettingService: Pick<SystemSettingService, 'getValue'>,
  agentService: Pick<AgentService, 'getAgent' | 'getDefaultAgent'>,
): Promise<number | null> {
  const configured = await systemSettingService.getValue(EMBED_AGENT_ID_KEY);
  if (hasText(configured)) {
    try {
      const agent = await agentService.getAgent(Number(configured!.trim()));
      if (agent.enabled === 0) {
        console.warn(`Embed 助手 Agent 已停用 (${configured})，回落默认 Agent`);
      } else {
        return agent.id!;
      }
    } catch (e) {
      console.warn(`Embed 助手 Agent 配置无效 (${configured})，回落默认 Agent: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fallback = await agentService.getDefaultAgent().catch(() => null);
  return fallback != null && fallback.enabled !== 0 ? fallback.id! : null;
}
