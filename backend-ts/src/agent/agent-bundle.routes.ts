import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { AgentBundleService } from './agent-bundle.service.js';

export interface AgentBundleRouteDeps {
  agentBundleService: AgentBundleService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * Agent Bundle 导出/导入（P1）。全部为管理员动作，权限复用 agent:write（不新增权限码）。
 * 导出响应体是 bundle JSON 本身（非 Result 信封）——bundle 文件顶层即格式契约；
 * 导入走常规 sendOk 信封。共享目录路由见 shared-agent.routes.ts。
 */
export function registerAgentBundleRoutes(app: FastifyInstance, deps: AgentBundleRouteDeps): void {
  const { agentBundleService, permissionService } = deps;

  app.get('/v1/agents/:id/bundle', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    const id = Number((request.params as { id: string }).id);
    // Fastify 对重复 query 参数返回数组（?inlineSkills=a&inlineSkills=b）——join 归一，避免下游 TypeError 变 500
    const rawInline = (request.query as Record<string, string | string[] | undefined>).inlineSkills;
    const inlineSkills = Array.isArray(rawInline) ? rawInline.join(',') : rawInline;
    const { bundle, filename } = await agentBundleService.exportBundle(id, inlineSkills);
    reply
      .header('Content-Type', 'application/json; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(bundle);
  });

  app.post('/v1/agent-bundle/import', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    const body = bodyOf<{ bundle?: unknown; confirm?: boolean }>(request);
    return sendOk(reply, await agentBundleService.importBundle(body.bundle, body.confirm === true, userId));
  });
}
