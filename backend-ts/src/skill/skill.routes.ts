import type { FastifyInstance, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { PassThrough } from 'node:stream';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendJson } from '../common/http-error.js';
import { pathParam, queryOptInt } from '../common/request.js';import { fail, ok } from '../common/result.js';
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

  app.get('/v1/admin/user-skills/options/users', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:read');
    const users = await userLookup.listOptions();
    return sendJson(reply, 200, ok(users.map((user) => ({
      id: Number(user.id),
      username: user.username,
      displayName: user.displayName ?? null,
    }))));
  });

  // 写入指定用户的个人技能目录，不进入系统技能库。同名目录按个人技能上传规则覆盖。
  app.post('/v1/admin/user-skills/upload', async (request, reply) => {
    const currentUserId = requireUserId(request);
    await requirePermission(permissionService, currentUserId, 'agent:write');
    const collected = await collectAdminSkillUpload(request);
    if (!collected.ok) {
      return sendJson(reply, 200, fail(400, collected.message));
    }
    const { files, userIdValues } = collected;
    const parsed = parseAssignUserIds(userIdValues);
    if (!parsed.ok) {
      return sendJson(reply, 200, fail(400, parsed.message));
    }
    const users = await userLookup.findByIds(parsed.ids);
    const userMap = new Map(users.map((user) => [Number(user.id), user]));
    const missing = parsed.ids.filter((id) => !userMap.has(id));
    if (missing.length > 0) {
      return sendJson(reply, 200, fail(400, `用户不存在: ${missing.join(',')}`));
    }

    const applied: number[] = [];
    let skills: string[] = [];
    for (const targetId of parsed.ids) {
      const result = userSkillService.uploadUserSkill(targetId, files);
      if (result.code !== 0 || result.data == null) {
        const prefix = applied.length > 0
          ? `已写入用户 ${applied.join(',')}，写入用户 ${targetId} 失败: `
          : '';
        return sendJson(reply, 200, {
          code: result.code === 0 ? 500 : result.code,
          message: `${prefix}${result.message}`,
          data: {
            skills,
            users: applied.map((id) => assignedUser(userMap, id)),
          },
          timestamp: Date.now(),
        });
      }
      applied.push(targetId);
      skills = result.data;
    }
    console.info(`Admin ${currentUserId} assigned skills [${skills.join(', ')}] to users [${applied.join(', ')}]`);
    return sendJson(reply, 200, ok({
      skills,
      users: parsed.ids.map((id) => assignedUser(userMap, id)),
    }));
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

const MAX_ASSIGN_USERS = 100;

export function parseAssignUserIds(values: string[]): { ok: true; ids: number[] } | { ok: false; message: string } {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const raw of values) {
    const text = raw.trim();
    if (!text) continue;
    let tokens: string[];
    if (text.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { ok: false, message: 'userIds 格式不正确' };
      }
      if (!Array.isArray(parsed)) return { ok: false, message: 'userIds 格式不正确' };
      tokens = parsed.map((item) => String(item).trim());
    } else {
      tokens = text.split(/[\s,]+/);
    }
    for (const token of tokens) {
      if (!token) continue;
      if (!/^[1-9]\d*$/.test(token)) {
        return { ok: false, message: `无效的用户 ID: ${token}` };
      }
      const id = Number(token);
      if (!Number.isSafeInteger(id)) {
        return { ok: false, message: `无效的用户 ID: ${token}` };
      }
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) return { ok: false, message: '请指定至少一个用户' };
  if (ids.length > MAX_ASSIGN_USERS) {
    return { ok: false, message: `一次最多指定 ${MAX_ASSIGN_USERS} 个用户` };
  }
  return { ok: true, ids };
}

function assignedUser(
  userMap: Map<number, { username: string; displayName?: string | null }>,
  id: number,
): { id: number; username: string | null; displayName: string | null } {
  const user = userMap.get(id);
  return {
    id,
    username: user?.username ?? null,
    displayName: user?.displayName ?? null,
  };
}

function multipartAbortMessage(error: unknown): string {
  const code = typeof error === 'object' && error != null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'FST_FILES_LIMIT') {
    return '上传文件数量超过上限，已中止且未写入。请去掉 node_modules、.git 等目录后重试';
  }
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return '上传文件过大，已中止且未写入';
  }
  const detail = error instanceof Error && error.message ? error.message : '上传内容不完整';
  return `上传未完成，已中止且未写入：${detail}`;
}

async function collectAdminSkillUpload(
  request: FastifyRequest,
): Promise<{ ok: true; files: UploadedSkillFile[]; userIdValues: string[] } | { ok: false; message: string }> {
  const files: UploadedSkillFile[] = [];
  const userIdValues: string[] = [];
  try {
    const parts = request.parts({ preservePath: true });
    for await (const part of parts) {
      if (part.type === 'file') {
        files.push({
          originalFilename: part.filename,
          buffer: await part.toBuffer(),
        });
      } else if (part.fieldname === 'userIds' || part.fieldname === 'userId') {
        userIdValues.push(String(part.value ?? ''));
      }
    }
  } catch (error) {
    return { ok: false, message: multipartAbortMessage(error) };
  }
  return { ok: true, files, userIdValues };
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
