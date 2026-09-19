import type { FastifyInstance, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { PassThrough } from 'node:stream';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendJson } from '../common/http-error.js';
import { pathParam, queryOptInt } from '../common/request.js';import { ok } from '../common/result.js';
import type { SkillSyncService } from '../harness/skill/skill-sync-service.js';
import type { AgentLookup, UserLookup } from '../session/types.js';
import type { SessionService } from '../session/session.service.js';
import type { SkillDocService } from './skill-doc.service.js';
import type { UploadedSkillFile, UserSkillService } from './user-skill.service.js';
import type { AgentService } from '../agent/agent.service.js';

export interface SkillRouteDeps {
  userSkillService: UserSkillService;
  skillDocService: SkillDocService;
  skillSyncService: SkillSyncService;
  sessionService: SessionService;
  agentLookup: AgentLookup;
  agentService: AgentService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  userLookup: UserLookup;
}

export function registerUserSkillRoutes(app: FastifyInstance, deps: Pick<SkillRouteDeps, 'userSkillService'>): void {
  const { userSkillService } = deps;

  app.get('/v1/user-skills', async (request, reply) => {
    const userId = requireUserId(request);
    return sendJson(reply, 200, ok(userSkillService.listUserSkills(userId)));
  });

  app.get('/v1/user-skills/:name', async (request, reply) => {
    const userId = requireUserId(request);
    const result = userSkillService.getUserSkill(userId, pathParam(request, 'name'));
    return sendJson(reply, 200, result.code === 0 ? ok(result.data) : result);
  });

  app.post('/v1/user-skills/upload', async (request, reply) => {
    const userId = requireUserId(request);
    const files = await collectNamedFiles(request, 'files');
    const result = userSkillService.uploadUserSkill(userId, files);
    return sendJson(reply, 200, result.code === 0 ? ok(result.data) : result);
  });

  app.delete('/v1/user-skills/:name', async (request, reply) => {
    const userId = requireUserId(request);
    const result = userSkillService.deleteUserSkill(userId, pathParam(request, 'name'));
    return sendJson(reply, 200, result.code === 0 ? ok(null) : result);
  });
}

export function registerAdminUserSkillRoutes(
  app: FastifyInstance,
  deps: Pick<SkillRouteDeps, 'userSkillService' | 'permissionService' | 'userLookup'>,
): void {
  const { userSkillService, permissionService, userLookup } = deps;

  // 列表：不传 userId 返回全部用户技能；传 userId 时仅返回该用户的技能（用户详情视图用）。
  app.get('/v1/admin/user-skills', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:read');
    const targetUserId = queryOptInt(request, 'userId');
    if (targetUserId != null) {
      return sendJson(reply, 200, ok(userSkillService.listUserSkills(targetUserId)));
    }
    const skills = userSkillService.listAllUserSkills();
    const userIds = [...new Set(skills.map((s) => s.userId))];
    const users = userIds.length > 0 ? await userLookup.findByIds(userIds) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    return sendJson(reply, 200, ok(skills.map((skill) => {
      const user = userMap.get(skill.userId);
      return {
        ...skill,
        username: user?.username ?? null,
        displayName: user?.displayName ?? null,
      };
    })));
  });

  app.get('/v1/admin/user-skills/:userId/:name', async (request, reply) => {
    const currentUserId = requireUserId(request);
    await requirePermission(permissionService, currentUserId, 'agent:read');
    const targetUserId = Number(pathParam(request, 'userId'));
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return sendJson(reply, 200, { code: 400, message: 'Invalid userId' });
    }
    const result = userSkillService.getUserSkill(targetUserId, pathParam(request, 'name'));
    return sendJson(reply, 200, result.code === 0 ? ok(result.data) : result);
  });

  app.delete('/v1/admin/user-skills/:userId/:name', async (request, reply) => {
    const currentUserId = requireUserId(request);
    await requirePermission(permissionService, currentUserId, 'agent:write');
    const targetUserId = Number(pathParam(request, 'userId'));
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return sendJson(reply, 200, { code: 400, message: 'Invalid userId' });
    }
    const result = userSkillService.deleteUserSkill(targetUserId, pathParam(request, 'name'));
    return sendJson(reply, 200, result.code === 0 ? ok(null) : result);
  });
}

export function registerSkillDocRoutes(
  app: FastifyInstance,
  deps: Pick<SkillRouteDeps, 'skillDocService' | 'agentService' | 'permissionService'>,
): void {
  const { skillDocService, agentService, permissionService } = deps;

  app.get('/v1/skill-docs', async (request, reply) => {
    requireUserId(request);
    return sendJson(reply, 200, ok(skillDocService.listSkillDocs()));
  });

  app.get('/v1/skill-docs/:name', async (request, reply) => {
    requireUserId(request);
    const result = skillDocService.getSkillDoc(pathParam(request, 'name'));
    return sendJson(reply, 200, result.code === 0 ? ok(result.data) : result);
  });

  app.post('/v1/skill-docs/upload', async (request, reply) => {
    const userId = requireUserId(request);
    // 系统级技能库写操作（覆盖系统技能），与个人 Skill 删除一致要求 agent:write
    await requirePermission(permissionService, userId, 'agent:write');
    const files = await collectNamedFiles(request, 'files');
    const result = skillDocService.uploadSkill(files);
    return sendJson(reply, 200, result.code === 0 ? ok(result.data) : result);
  });

  app.delete('/v1/skill-docs/:name', async (request, reply) => {
    const userId = requireUserId(request);
    // 删除会级联清理所有 Agent 的 skillName，破坏面大，须 agent:write
    await requirePermission(permissionService, userId, 'agent:write');
    const skillName = pathParam(request, 'name');
    const result = skillDocService.deleteSkill(skillName);
    if (result.code === 0) {
      try {
        const affected = await agentService.removeSkillNameFromAll(skillName);
        if (affected > 0) {
          console.info(`Cleaned up skillName '${skillName}' from ${affected} agent(s)`);
        }
      } catch (e) {
        console.error(`Failed to clean up skillName '${skillName}' from agents: ${(e as Error).message}`);
      }
    }
    return sendJson(reply, 200, result.code === 0 ? ok(null) : result);
  });
}

export function registerSkillSyncRoutes(app: FastifyInstance, deps: Pick<SkillRouteDeps, 'skillSyncService' | 'sessionService' | 'agentLookup'>): void {
  app.post('/v1/skills/sync-package', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = queryOptInt(request, 'sessionId');
    if (sessionId == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const session = await deps.sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该会话');
    }
    const agent = session.agentId != null ? await deps.agentLookup.findById(session.agentId) : null;
    if (agent == null) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    const stream = new PassThrough();
    const writing = deps.skillSyncService.writeSyncZip(agent, sessionId, stream, session.userId);
    reply
      .type('application/zip')
      .header('Content-Disposition', 'attachment; filename="skills.zip"');
    reply.send(stream);
    await writing;
  });
}

export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): void {
  registerUserSkillRoutes(app, deps);
  registerAdminUserSkillRoutes(app, deps);
  registerSkillDocRoutes(app, deps);
  registerSkillSyncRoutes(app, deps);
}

async function collectNamedFiles(request: FastifyRequest, fieldName: string): Promise<UploadedSkillFile[]> {
  const files: UploadedSkillFile[] = [];
  try {
    // Busboy 默认会丢掉 filename 中的目录（skill/SKILL.md → SKILL.md），
    // 与 Spring MultipartFile.getOriginalFilename() 不一致，导致技能上传无法按子目录分组。
    const parts = request.parts({ preservePath: true });
    for await (const part of parts) {
      if (part.type === 'file' && (part.fieldname === fieldName || fieldName === 'files')) {
        files.push({
          originalFilename: part.filename,
          buffer: await part.toBuffer(),
        });
      } else if (part.type === 'file') {
        await part.toBuffer();
      }
    }
  } catch {
    return files;
  }
  return files;
}
