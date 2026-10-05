import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { SharedAgentService } from './shared-agent.service.js';

export interface SharedAgentRouteDeps {
  sharedAgentService: SharedAgentService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * 团队共享目录（P2）：
 * - GET /v1/shared-agents 登录即可（工作台"团队共享"分区数据源，含按当前用户的依赖自检）；
 * - POST /v1/shared-agents/:agentId/fix-deps 登录即可（依赖一键补装，安装目标永远是操作者本人）；
 * - PUT/DELETE /v1/agents/:id/shared-entry 为管理员动作（agent:write）。
 */
export function registerSharedAgentRoutes(app: FastifyInstance, deps: SharedAgentRouteDeps): void {
  const { sharedAgentService, permissionService } = deps;

  app.get('/v1/shared-agents', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await sharedAgentService.listSharedAgents(userId));
  });

  app.post('/v1/shared-agents/:agentId/fix-deps', async (request, reply) => {
    const userId = requireUserId(request);
    const agentId = pathId(request, 'agentId');
    return sendOk(reply, await sharedAgentService.fixDependencies(agentId, userId));
  });

  app.put('/v1/agents/:id/shared-entry', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    const body = bodyOf<{ note?: string | null; sortOrder?: number | null; sourceUrl?: string | null }>(request);
    await sharedAgentService.putEntry(Number((request.params as { id: string }).id), body.note, body.sortOrder, userId, body.sourceUrl);
    return sendOk(reply);
  });

  app.delete('/v1/agents/:id/shared-entry', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    await sharedAgentService.removeEntry(Number((request.params as { id: string }).id));
    return sendOk(reply);
  });
}
