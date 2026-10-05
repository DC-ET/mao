import type { FastifyInstance, FastifyReply } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathParam, queryOptInt } from '../common/request.js';
import type { SkillBundle } from './skill-bundle.types.js';
import type { SkillBundleService } from './skill-bundle.service.js';

export interface SkillBundleRouteDeps {
  skillBundleService: SkillBundleService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

function sendBundle(reply: FastifyReply, bundle: SkillBundle, filename: string): FastifyReply {
  reply
    .header('Content-Type', 'application/json; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(bundle);
}

/**
 * mao-skill-bundle v1 导出/导入（资产分发闭环 P3）：
 * - GET /v1/skill-bundles/:name：无 owner 参数 = 系统技能（要求 skill:read）；?owner=<userId> 导出指定用户技能，
 *   本人即可，他人需 skill:read（与 admin 用户技能查看同口径）；
 * - POST /v1/skill-bundle/import 要求 skill:write（管理员），两段式写系统技能目录。
 */
export function registerSkillBundleRoutes(app: FastifyInstance, deps: SkillBundleRouteDeps): void {
  const { skillBundleService, permissionService } = deps;

  app.get('/v1/skill-bundles/:name', async (request, reply) => {
    const userId = requireUserId(request);
    const name = pathParam(request, 'name');
    const owner = queryOptInt(request, 'owner');
    if (owner != null && owner !== userId) {
      // 指定 owner 导出他人技能：skill:read（管理员口径，与 admin 用户技能查看一致）
      await requirePermission(permissionService, userId, 'skill:read');
      const { bundle, filename } = await skillBundleService.exportSkillBundle(name, owner);
      return sendBundle(reply, bundle, filename);
    }
    if (owner == null && skillBundleService.hasSystemSkill(name)) {
      await requirePermission(permissionService, userId, 'skill:read');
      const { bundle, filename } = await skillBundleService.exportSkillBundle(name, null);
      return sendBundle(reply, bundle, filename);
    }
    // 本人用户技能；若既非系统技能也非本人技能，export 抛 SKILL_NOT_FOUND
    const { bundle, filename } = await skillBundleService.exportSkillBundle(name, owner ?? userId);
    return sendBundle(reply, bundle, filename);
  });

  app.post('/v1/skill-bundle/import', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'skill:write');
    const body = bodyOf<{ bundle?: unknown; confirm?: boolean }>(request);
    return sendOk(reply, skillBundleService.importSkillBundle(body.bundle, body.confirm === true));
  });
}
