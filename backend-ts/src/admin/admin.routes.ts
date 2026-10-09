import type { FastifyInstance } from 'fastify';
import { requireRequestPermission } from '../common/http-error.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { AdminAnalyticsService } from './admin-analytics.service.js';
import type { MemoryPageVO, MemoryScope, MemoryStatus } from '../memory/types.js';

export interface AdminSessionLister {
  listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number,
    agentId?: number,
    executionMode?: string,
    phase?: string,
    keyword?: string,
    status?: string,
  ): Promise<{ records: unknown[]; total: number; current: number; size: number; matchSnippets?: Record<number, string> }>;
}

/** 管理后台记忆审计：跨用户只读查询（no ownership check，路由侧已做 memory:read 校验）。 */
export interface AdminMemoryAuditor {
  listForAdmin(
    userId: number,
    query: { scope?: MemoryScope | null; projectKey?: string | null; status?: MemoryStatus | null; page: number; pageSize: number },
  ): Promise<MemoryPageVO>;
}

export interface AdminUserLookup {
  findByIds(ids: number[]): Promise<Array<{ id: number; username: string; displayName?: string | null }>>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  memoryAuditor?: AdminMemoryAuditor;
  memoryUserLookup?: AdminUserLookup;
}

interface AnalyticsQueryRaw {
  days?: string;
  endOffset?: string;
  limit?: string;
  excludeConnectivity?: string;
  modelId?: string;
}

function parseAnalyticsQuery(raw: AnalyticsQueryRaw): {
  days: number;
  endOffset: number;
  limit: number;
  excludeConnectivity: boolean;
  modelId: number | null;
} {
  const days = Number(raw.days ?? 30);
  const endOffset = Number(raw.endOffset ?? 0);
  const limit = Number(raw.limit ?? 20);
  const modelIdRaw = raw.modelId == null || raw.modelId === '' ? null : Number(raw.modelId);
  return {
    days: Math.max(1, Math.min(Number.isFinite(days) ? days : 30, 90)),
    endOffset: Math.max(0, Math.min(Number.isFinite(endOffset) ? endOffset : 0, 365)),
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100)),
    // 默认排除连通性测试，避免模型配置自检污染质量指标
    excludeConnectivity: raw.excludeConnectivity !== 'false' && raw.excludeConnectivity !== '0',
    modelId: modelIdRaw != null && Number.isFinite(modelIdRaw) ? modelIdRaw : null,
  };
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // 旧巨型汇总：管理后台已切换 scope 接口，暂留给 mao-cli / 兼容调用方。
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.summary(days, endOffset)));
  });

  app.get('/v1/admin/analytics/overview', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.overview(days, endOffset)));
  });

  app.get('/v1/admin/analytics/trends', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const granularity = (req.query as { granularity?: string }).granularity === 'hour' ? 'hour' : 'day';
    sendJson(reply, 200, ok(await deps.analytics.trendsScope(days, endOffset, { excludeConnectivity, granularity })));
  });

  app.get('/v1/admin/analytics/models', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity, modelId } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(
      reply,
      200,
      ok(await deps.analytics.modelsScope(days, endOffset, { excludeConnectivity, sceneModelId: modelId })),
    );
  });

  app.get('/v1/admin/analytics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.usersScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/agents', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.agentsScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.sessionsScope(days, endOffset, { excludeConnectivity })));
  });

  // 运行轨迹聚合：最慢轮 / 最贵轮（按 scope 维度）+ 工具失败率（按活动 type）
  app.get('/v1/admin/analytics/run-trace', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const q = req.query as { scene?: string; scope?: string };
    const scene = typeof q.scene === 'string' && q.scene.trim() !== '' ? q.scene.trim() : 'agent';
    const scope = q.scope === 'user' ? 'user' : 'agent';
    sendJson(reply, 200, ok(await deps.analytics.runTraceScope(days, endOffset, { scene, scope, limit })));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'session:read');
    const q = req.query as {
      page?: string;
      size?: string;
      userId?: string;
      agentId?: string;
      executionMode?: string;
      phase?: string;
      keyword?: string;
      status?: string;
    };
    const page = Number(q.page ?? 1);
    const size = Number(q.size ?? 20);
    const runtimePhase = !q.phase || q.phase.trim() === ''
      ? 'RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED'
      : q.phase;
    if (!deps.sessionLister) {
      sendJson(reply, 200, ok({ records: [], total: 0, page, size }));
      return;
    }
    const result = await deps.sessionLister.listSessionsForAdmin(
      page,
      size,
      q.userId != null ? Number(q.userId) : undefined,
      q.agentId != null ? Number(q.agentId) : undefined,
      q.executionMode,
      runtimePhase,
      q.keyword,
      q.status,
    );
    sendJson(reply, 200, ok(result));
  });

  // 用户记忆只读审计（技术方案 5.4）：按 userId 查看记忆内容，仅查询、无任何写接口
  app.get('/v1/admin/memory', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'memory:read');
    const q = req.query as { userId?: string; page?: string; pageSize?: string; scope?: string; status?: string };
    const userId = Number(q.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) {
      sendJson(reply, 200, ok({ records: [], total: 0, current: 1, size: 20 }));
      return;
    }
    if (!deps.memoryAuditor) {
      sendJson(reply, 200, ok({ records: [], total: 0, current: 1, size: 20 }));
      return;
    }
    const page = Math.max(1, Math.floor(Number(q.page ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(q.pageSize ?? 20)) || 20));
    const scope = q.scope === 'USER' || q.scope === 'PROJECT' ? q.scope : null;
    const status = q.status === 'ACTIVE' || q.status === 'DISMISSED' ? q.status : null;
    const result = await deps.memoryAuditor.listForAdmin(userId, {
      scope,
      status,
      projectKey: null,
      page,
      pageSize,
    });
    if (deps.memoryUserLookup && result.records.length > 0) {
      try {
        const users = await deps.memoryUserLookup.findByIds([userId]);
        const user = users.find((u) => u.id === userId);
        result.records = result.records.map((item) => ({
          ...item,
          username: user?.username ?? null,
          displayName: user?.displayName ?? null,
        }));
      } catch {
        // 用户信息补全失败不影响审计列表返回
      }
    }
    sendJson(reply, 200, ok(result));
  });

}
