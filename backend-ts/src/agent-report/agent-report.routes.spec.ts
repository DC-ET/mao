import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAgentReportRoutes, type AgentReportRouteDeps } from './agent-report.routes.js';
import type { AgentReportService } from './agent-report.service.js';
import type { JwtService } from '../crypto/jwt.service.js';

/**
 * 管理端点与权限拆分测试（仿 feedback.routes.spec.ts）：mock service，
 * 只验证路由的权限码、参数解析与透传。403 口径：BusinessException(403) → handleError → HTTP 403 + code=1002。
 */

const READ = 'agent-report:read';

const ROW = {
  id: 1, sessionId: 11, userId: 7, username: 'alice', agentId: 3, agentName: 'Coder',
  category: 'tool_defect', severity: 'high', title: 'shell 循环失败', detail: '证据',
  status: 'OPEN', resolutionNote: null, resolvedBy: null, resolvedByName: null,
  resolvedAt: null, createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
};

function makeDeps(over: Partial<AgentReportRouteDeps> = {}) {
  const calls: Record<string, unknown[][]> = {};
  const agentReport = {
    summary: vi.fn(async () => ({ byStatus: { OPEN: 1, ACKNOWLEDGED: 0, RESOLVED: 0, DISMISSED: 0 }, openCount: 1 })),
    pageList: vi.fn(async (...args: unknown[]) => {
      (calls.pageList ??= []).push(args);
      return { total: 1, items: [ROW] };
    }),
    detail: vi.fn(async (...args: unknown[]) => {
      (calls.detail ??= []).push(args);
      return ROW;
    }),
    updateStatus: vi.fn(async (...args: unknown[]) => {
      (calls.updateStatus ??= []).push(args);
      return { ...ROW, status: args[2] };
    }),
  };
  return {
    deps: {
      jwt: {} as JwtService,
      agentReport: agentReport as unknown as AgentReportService,
      permissionService: { hasPermission: vi.fn(async () => true) },
      ...over,
    },
    calls,
    agentReport,
  };
}

async function app(deps: AgentReportRouteDeps) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    (req as { userId?: number }).userId = 7;
    done();
  });
  registerAgentReportRoutes(fastify, deps);
  await fastify.ready();
  return fastify;
}

function json(response: { body: string }) {
  return JSON.parse(response.body) as { code: number; data?: Record<string, unknown> };
}

describe('agent-report admin routes', () => {
  it('list 把 status/category/severity/时间区间/分页透传给 service', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'GET',
      url: '/v1/agent-report/admin/list?status=OPEN&category=tool_defect&severity=high&startDate=2026-11-01&endDate=2026-11-27&page=2&pageSize=5',
    }));
    expect(response.code).toBe(0);
    expect(calls.pageList[0][0]).toMatchObject({
      status: 'OPEN', category: 'tool_defect', severity: 'high',
      startDate: '2026-11-01', endDate: '2026-11-27', page: 2, pageSize: 5,
    });
    await fastify.close();
  });

  it('list 丢弃非法枚举值（按不筛选处理），非法日期格式不传', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'GET',
      url: '/v1/agent-report/admin/list?status=BOGUS&category=xxx&severity=extreme&startDate=11-01',
    }));
    expect(response.code).toBe(0);
    const filter = calls.pageList[0][0] as Record<string, unknown>;
    expect(filter.status).toBeUndefined();
    expect(filter.category).toBeUndefined();
    expect(filter.severity).toBeUndefined();
    expect(filter.startDate).toBeUndefined();
    await fastify.close();
  });

  it('detail 返回完整行；非法 id 收敛为 0（service 抛 NOT_FOUND）', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const found = json(await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/1' }));
    expect(found.code).toBe(0);
    expect(found.data).toMatchObject({ id: 1, title: 'shell 循环失败' });
    await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/abc' });
    expect(calls.detail[1][0]).toBe(0);
    await fastify.close();
  });

  it('detail 不存在时按业务码返回（HTTP 200 + 3059）', async () => {
    const { BusinessException } = await import('../common/business-exception.js');
    const { deps } = makeDeps({
      agentReport: {
        detail: vi.fn(async () => { throw new BusinessException(ErrorCode.AGENT_REPORT_NOT_FOUND); }),
      } as unknown as AgentReportService,
    });
    const fastify = await app(deps);
    const response = await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/404' });
    expect(response.statusCode).toBe(200);
    expect(json(response).code).toBe(ErrorCode.AGENT_REPORT_NOT_FOUND.code);
    await fastify.close();
  });

  it('status 流转透传操作人/目标态/备注', async () => {
    const { deps, calls } = makeDeps();
    const fastify = await app(deps);
    const response = json(await fastify.inject({
      method: 'PUT',
      url: '/v1/agent-report/admin/1/status',
      payload: { status: 'RESOLVED', note: '已修复' },
    }));
    expect(response.code).toBe(0);
    expect(calls.updateStatus[0]).toEqual([7, 1, 'RESOLVED', '已修复']);
    await fastify.close();
  });

  it('agent-report:read 可读 list/summary/detail，但不能写 status（403 + code=1002）', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async (_u: number, code: string) => code === READ) },
    });
    const fastify = await app(deps);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/list' })).code).toBe(0);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/summary' })).code).toBe(0);
    expect(json(await fastify.inject({ method: 'GET', url: '/v1/agent-report/admin/1' })).code).toBe(0);
    const write = json(await fastify.inject({
      method: 'PUT', url: '/v1/agent-report/admin/1/status', payload: { status: 'RESOLVED' },
    }));
    expect(write.code).toBe(1002);
    expect(calls.updateStatus).toBeUndefined();
    await fastify.close();
  });

  it('无权限时四个管理端点全部 403，不触达 service', async () => {
    const { deps, calls } = makeDeps({
      permissionService: { hasPermission: vi.fn(async () => false) },
    });
    const fastify = await app(deps);
    for (const [method, url, payload] of [
      ['GET', '/v1/agent-report/admin/list', undefined],
      ['GET', '/v1/agent-report/admin/summary', undefined],
      ['GET', '/v1/agent-report/admin/1', undefined],
      ['PUT', '/v1/agent-report/admin/1/status', { status: 'RESOLVED' }],
    ] as Array<[string, string, unknown]>) {
      const response = json(await fastify.inject({ method: method as 'GET', url, payload }));
      expect(response.code).toBe(1002);
    }
    expect(calls.pageList).toBeUndefined();
    expect(calls.detail).toBeUndefined();
    expect(calls.updateStatus).toBeUndefined();
    await fastify.close();
  });
});
