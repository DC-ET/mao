import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { BundleRegistrySettings } from '../settings/types.js';
import type { AgentBundleService } from './agent-bundle.service.js';

export interface AgentBundleRouteDeps {
  agentBundleService: AgentBundleService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  /** registry 开关（SystemSettingService.getBundleRegistryConfig 已实现）。 */
  registryConfig: { getBundleRegistryConfig(): Promise<BundleRegistrySettings> };
}

/**
 * Agent Bundle 导出/导入（P1）+ registry 只读端点 / URL 导入 / 检查更新（P2）。
 * 导出与 registry 响应体是 bundle JSON 本身（非 Result 信封）——bundle 文件顶层即格式契约；
 * 其余走常规 sendOk 信封。共享目录路由见 shared-agent.routes.ts。
 */
export function registerAgentBundleRoutes(app: FastifyInstance, deps: AgentBundleRouteDeps): void {
  const { agentBundleService, permissionService, registryConfig } = deps;

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

  app.post('/v1/agent-bundle/import-from-url', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    const body = bodyOf<{ url?: string; confirm?: boolean }>(request);
    return sendOk(reply, await agentBundleService.importBundleFromUrl(String(body.url ?? ''), body.confirm === true, userId));
  });

  app.post('/v1/agent-bundle/check-updates', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    const body = bodyOf<{ agentIds?: unknown }>(request);
    const ids = Array.isArray(body.agentIds)
      ? body.agentIds.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0)
      : [];
    return sendOk(reply, await agentBundleService.checkUpdates(ids.length > 0 ? ids : null));
  });

  /**
   * registry 只读端点（本提案唯一对外暴露面）：登录校验由 isPublicPath 前缀放行（jwt-hook.ts），
   * 开关与 token 校验在本路由内做——关闭时 404 不暴露存在性；token 非常量时间比较。
   * 失败映射自行处理（BusinessException 默认会走 handleError 变 HTTP 200 + fail 信封，与此处契约冲突）：
   * Agent 不存在/停用/开关关闭/ token 错误 → 404；导出失败（同名歧义/超 inline 上限）→ 409 结构化 JSON。
   */
  app.get('/v1/agent-bundle/registry/:agentId', async (request, reply) => {
    const id = Number((request.params as { agentId: string }).agentId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return reply.status(404).send({ error: 'not found' });
    }
    const config = await registryConfig.getBundleRegistryConfig();
    if (!config.enabled) {
      return reply.status(404).send({ error: 'not found' });
    }
    if (config.accessToken != null) {
      const query = request.query as Record<string, string | undefined>;
      const presented = request.headers['x-mao-registry-token'] ?? query.token ?? '';
      const tokenText = Array.isArray(presented) ? presented[0] : presented;
      if (!registryTokenEquals(tokenText ?? '', config.accessToken)) {
        return reply.status(404).send({ error: 'not found' });
      }
    }
    try {
      const { bundle, contentHash } = await agentBundleService.exportRegistryBundle(id);
      reply.header('X-Mao-Content-Hash', contentHash).header('Content-Type', 'application/json; charset=utf-8');
      return reply.send(bundle);
    } catch (e) {
      if (e instanceof BusinessException && e.code === ErrorCode.AGENT_NOT_FOUND.code) {
        return reply.status(404).send({ error: 'not found' });
      }
      const detail = e instanceof Error ? [e.message] : [];
      return reply.status(409).send({ error: 'bundle 导出失败', detail });
    }
  });
}

/** 非常量时间比较；长度不等直接拒绝（长度本身不构成敏感信息）。 */
function registryTokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
