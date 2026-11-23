import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { resolveActivityWindow } from '../session/message-search.js';
import type { LlmCallService } from './llm-call.service.js';
import { registerLlmCallRoutes, resolveAdminLlmCallListWindow } from './llm-call.routes.js';

const NOW = new Date('2026-11-06T08:00:00+08:00');

describe('resolveAdminLlmCallListWindow', () => {
  it('缺省最近 7 天（含今天），上界是次日 00:00:00', () => {
    expect(resolveAdminLlmCallListWindow({ now: NOW })).toEqual({
      startAt: '2026-10-31 00:00:00',
      endAtExclusive: '2026-11-07 00:00:00',
    });
  });

  it('预设档按上海日历计算，大小写不敏感', () => {
    expect(resolveAdminLlmCallListWindow({ range: '1d', now: NOW })).toEqual({
      startAt: '2026-11-06 00:00:00',
      endAtExclusive: '2026-11-07 00:00:00',
    });
    expect(resolveAdminLlmCallListWindow({ range: '30D', now: NOW }).startAt).toBe('2026-10-08 00:00:00');
  });

  it('range=ALL 不限时间，即使同时带了日期', () => {
    expect(resolveAdminLlmCallListWindow({ range: 'ALL', startDate: '2026-11-01', endDate: '2026-11-06', now: NOW })).toEqual({});
  });

  it('深链 startDate/endDate 与 dateFrom/dateTo 都是显式区间，优先于预设档', () => {
    expect(resolveAdminLlmCallListWindow({ startDate: '2026-11-01', endDate: '2026-11-06', now: NOW })).toEqual({
      startAt: '2026-11-01 00:00:00',
      endAtExclusive: '2026-11-07 00:00:00',
    });
    expect(resolveAdminLlmCallListWindow({
      range: '30D',
      dateFrom: '2026-11-01',
      dateTo: '2026-11-03',
      startDate: '2026-01-01',
      now: NOW,
    })).toEqual({
      startAt: '2026-11-01 00:00:00',
      endAtExclusive: '2026-11-04 00:00:00',
    });
  });

  it('单边日期只收对应的界', () => {
    expect(resolveAdminLlmCallListWindow({ startDate: '2026-11-01', now: NOW })).toEqual({
      startAt: '2026-11-01 00:00:00',
    });
    expect(resolveAdminLlmCallListWindow({ endDate: '2026-11-06', now: NOW })).toEqual({
      endAtExclusive: '2026-11-07 00:00:00',
    });
  });

  it('非法档位或日期直接拒绝，不回落成不限时间', () => {
    expect(() => resolveAdminLlmCallListWindow({ range: '5Y' })).toThrow('时间范围不合法');
    expect(() => resolveAdminLlmCallListWindow({ startDate: '2026-02-31' })).toThrow('日期不合法');
    expect(() => resolveAdminLlmCallListWindow({ startDate: '2026-11-07', endDate: '2026-11-01' })).toThrow('开始日期不能晚于结束日期');
  });
});

describe('GET /v1/admin/llm-calls 时间窗', () => {
  function buildApp() {
    const listForAdmin = vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 }));
    const listForUser = vi.fn(async () => ({ records: [], total: 0, page: 1, size: 20 }));
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (request, _reply, done) => {
      request.userId = 9;
      done();
    });
    registerLlmCallRoutes(app, {
      llmCallService: { listForAdmin, listForUser } as unknown as LlmCallService,
      permissionService: { hasPermission: vi.fn(async () => true) } as never,
    });
    return { app, listForAdmin, listForUser };
  }

  it('不带时间参数时兜底最近 7 天', async () => {
    const { app, listForAdmin } = buildApp();
    const before = resolveActivityWindow({ now: new Date() });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/llm-calls' });
    const after = resolveActivityWindow({ now: new Date() });
    expect(res.statusCode).toBe(200);
    const filter = listForAdmin.mock.calls[0]?.[2] as { startAt?: string; endAtExclusive?: string };
    const matched = [before, after].some((window) => window?.from === filter.startAt && window?.toExclusive === filter.endAtExclusive);
    expect(matched).toBe(true);
  });

  it('range=ALL 把窗口放开；startDate/endDate 深链原样进筛选', async () => {
    const { app, listForAdmin } = buildApp();
    await app.inject({ method: 'GET', url: '/v1/admin/llm-calls?range=ALL&startDate=2026-11-01' });
    expect(listForAdmin).toHaveBeenLastCalledWith(1, 20, expect.objectContaining({
      startAt: undefined,
      endAtExclusive: undefined,
    }));

    await app.inject({ method: 'GET', url: '/v1/admin/llm-calls?startDate=2026-11-01&endDate=2026-11-06&scene=agent' });
    expect(listForAdmin).toHaveBeenLastCalledWith(1, 20, expect.objectContaining({
      scene: 'agent',
      startAt: '2026-11-01 00:00:00',
      endAtExclusive: '2026-11-07 00:00:00',
    }));
  });

  it('非法 range 不查库', async () => {
    const { app, listForAdmin } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/admin/llm-calls?range=5Y' });
    const body = JSON.parse(res.body) as { code: number; message: string };
    expect(body.code).toBe(2001);
    expect(body.message).toContain('时间范围不合法');
    expect(listForAdmin).not.toHaveBeenCalled();
  });

  it('用户端明细缺省不补 7 天窗口', async () => {
    const { app, listForUser } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/llm-calls/me' });
    expect(res.statusCode).toBe(200);
    expect(listForUser).toHaveBeenCalledWith(9, 1, 20, expect.objectContaining({
      startAt: undefined,
      endAtExclusive: undefined,
    }));
  });
});
