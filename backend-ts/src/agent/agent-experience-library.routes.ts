import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { AgentService } from './agent.service.js';
import type { ExperienceIndexService } from '../harness/experience/experience-index.service.js';

/**
 * Agent 团队经验库管理接口（技术方案 2026-10-24 §4.1）。
 *
 * 直接操作 <shareDir>/agent-experience/<agentId>/ 下的子文档与索引；
 * 开关（experience_library_enabled）只改标记位，挂载/注入在会话创建与上下文装配点按位判定。
 * enabled=0 时文档接口仍可用——admin 可先整理内容再开启。
 */
export interface AgentExperienceLibraryRouteDeps {
  agentService: AgentService;
  experienceIndexService: ExperienceIndexService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface SaveDocRequest {
  fileName?: string | null;
  content?: string | null;
}

export function registerAgentExperienceLibraryRoutes(app: FastifyInstance, deps: AgentExperienceLibraryRouteDeps): void {
  const { agentService, experienceIndexService, permissionService } = deps;

  async function requireAgentWrite(request: Parameters<typeof requireUserId>[0]): Promise<number> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    return userId;
  }

  /** 校验 Agent 存在并返回其库目录（getAgent 不存在时抛 AGENT_NOT_FOUND）。 */
  async function requireAgentDir(agentId: number): Promise<{ agentDir: string; enabled: boolean }> {
    const agent = await agentService.getAgent(agentId);
    return {
      agentDir: experienceIndexService.dirFor(agentId),
      enabled: (agent.experienceLibraryEnabled ?? 1) === 1,
    };
  }

  function requireDocFileName(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 不能为空');
    }
    // basename 约束：拒绝路径分隔符 / .. / 反斜杠（防目录穿越），必须 .md 结尾
    if (raw.includes('/') || raw.includes('\\') || raw.includes('..') || !raw.toLowerCase().endsWith('.md')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'file 必须是 .md 结尾的文件名（不含路径）');
    }
    return raw;
  }

  app.patch('/v1/agents/:id/experience-library', async (request, reply) => {
    await requireAgentWrite(request);
    const body = bodyOf<{ enabled?: boolean }>(request);
    if (typeof body.enabled !== 'boolean') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'enabled 必须为布尔值');
    }
    const agent = await agentService.setExperienceLibraryEnabled(pathId(request), body.enabled);
    return sendOk(reply, { enabled: (agent.experienceLibraryEnabled ?? 1) === 1 });
  });

  app.get('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    requireUserId(request);
    const { agentDir, enabled } = await requireAgentDir(pathId(request));
    const docs = experienceIndexService.listDocs(agentDir);
    const indexContent = experienceIndexService.readDoc(agentDir, 'INDEX.md') ?? '';
    return sendOk(reply, { enabled, docs, indexContent });
  });

  app.get('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    requireUserId(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    const content = experienceIndexService.readDoc(agentDir, fileName);
    if (content == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `经验文档不存在: ${fileName}`);
    }
    return sendOk(reply, { fileName, content });
  });

  app.put('/v1/agents/:id/experience-library/docs/content', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const body = bodyOf<SaveDocRequest>(request);
    const fileName = requireDocFileName(body.fileName);
    if (fileName === 'INDEX.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能直接编辑');
    }
    if (body.content == null || typeof body.content !== 'string') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'content 不能为空');
    }
    let bytes: number;
    try {
      bytes = experienceIndexService.writeDoc(agentDir, fileName, body.content);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply, { fileName, bytes });
  });

  app.delete('/v1/agents/:id/experience-library/docs', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    const fileName = requireDocFileName((request.query as Record<string, unknown>).file);
    if (fileName === 'INDEX.md') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'INDEX.md 由系统自动生成，不能删除');
    }
    try {
      experienceIndexService.deleteDoc(agentDir, fileName);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    return sendOk(reply);
  });

  app.post('/v1/agents/:id/experience-library/index/rebuild', async (request, reply) => {
    await requireAgentWrite(request);
    const { agentDir } = await requireAgentDir(pathId(request));
    experienceIndexService.rebuild(agentDir);
    return sendOk(reply);
  });
}
