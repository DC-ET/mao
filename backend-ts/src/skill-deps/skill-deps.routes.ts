import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { SkillDepsService } from './skill-deps.service.js';

/**
 * 技能运行依赖端点（管理后台 Skills 页「运行依赖」列）：
 * - GET status（skill:read）：按技能名聚合的依赖状态 + 安装进度轮询；
 * - POST :skill/install（skill:write）：显式安装（Agent / 角色授权保存触发的 ensure 走 service 内部）。
 * `/v1/admin` 前缀自动进审计拦截器。
 */
export function registerSkillDepsRoutes(
  api: FastifyInstance,
  deps: { service: SkillDepsService; permissionService: { hasPermission(userId: number, code: string): Promise<boolean> } },
): void {
  api.get('/v1/admin/skill-deps/status', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'skill:read');
    const skills = await deps.service.getStatusMap();
    sendJson(reply, 200, ok({ skills }));
  });

  api.post<{ Params: { skill: string } }>('/v1/admin/skill-deps/:skill/install', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'skill:write');
    const result = await deps.service.install(req.params.skill);
    sendJson(reply, 200, ok(result));
  });
}
