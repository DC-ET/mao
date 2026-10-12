import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { ErrorCode } from '../common/error-code.js';
import { DigestService } from './service.js';
import type { DigestRepository } from './repository.js';
import type { DigestData, DigestInboxPort, DigestOutboundPort, DigestPreferenceRow } from './types.js';
import { registerDigestRoutes } from './routes.js';

/** 固定“现在”：2026-10-12 10:00（Asia/Shanghai）→ 昨天 = 2026-10-11。 */
const NOW = new Date('2026-10-12T10:00:00+08:00');
const YESTERDAY = '2026-10-11';

function prefRow(overrides: Partial<DigestPreferenceRow> = {}): DigestPreferenceRow {
  return {
    userId: 7,
    enabled: 1,
    pushTime: '09:30',
    outboundEnabled: 1,
    lastDigestDate: null,
    ...overrides,
  };
}

function busyData(): DigestData {
  return {
    coveredDate: YESTERDAY,
    tasks: { completed: 3, failed: 1, failedTop: [] },
    scheduled: null,
    watchers: null,
    approvals: null,
    cost: { totalMicros: 3_420_000, unpricedCalls: 0, calls: 4, top: [] },
    openApi: null,
  };
}

/** 真 DigestService + fake 仓储/端口：路由校验逻辑与 service 装配一并覆盖。 */
function buildApp(opts: {
  repo?: Partial<Record<string, unknown>>;
  savePreferences?: (patch: unknown) => Promise<unknown>;
} = {}) {
  const repo = {
    findPreference: vi.fn(async () => prefRow()),
    listEnabledUsers: vi.fn(async () => []),
    upsertPreference: vi.fn(async () => undefined),
    markProcessed: vi.fn(async () => undefined),
    countTaskTerminal: vi.fn(async () => ({ completed: 3, failed: 1 })),
    listFailedTasks: vi.fn(async () => []),
    countScheduledRuns: vi.fn(async () => ({ total: 0, completed: 0, failed: 0 })),
    listPausedTasks: vi.fn(async () => []),
    countWatcherTriggers: vi.fn(async () => 0),
    listDisabledWatchers: vi.fn(async () => []),
    countPendingApprovals: vi.fn(async () => 0),
    listPendingApprovals: vi.fn(async () => []),
    sumCostByAgent: vi.fn(async () => [{ agentId: 1, micros: 3_420_000, calls: 2, unpriced: 0 }]),
    findAgentNames: vi.fn(async () => new Map([[1, '助手A']])),
    countOpenApiCalls: vi.fn(async () => ({ total: 0, rejected: 0 })),
    ...opts.repo,
  } as unknown as DigestRepository;
  const inbox: DigestInboxPort = {
    writeDigestEntry: vi.fn(async () => undefined),
    hasDigestEntry: vi.fn(async () => false),
  };
  const outbound = { dispatchDigest: vi.fn() } as unknown as DigestOutboundPort;
  const service = new DigestService({ repo, inbox, outbound, now: () => NOW });
  if (opts.savePreferences) {
    service.savePreferences = vi.fn(opts.savePreferences) as never;
  }
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (req, _reply, done) => { req.userId = 7; done(); });
  registerDigestRoutes(app, { service });
  return { app, repo, inbox, outbound, service };
}

describe('digest routes', () => {
  it('GET /v1/digest/preferences 返回偏好视图（含三态与昨天日期）', async () => {
    const { app } = buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/digest/preferences' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.code).toBe(0);
      expect(body.data).toMatchObject({
        enabled: true,
        pushTime: '09:30',
        outboundEnabled: true,
        yesterdayStatus: 'PENDING',
        yesterdayCoveredDate: YESTERDAY,
      });
    } finally {
      await app.close();
    }
  });

  it('PATCH 非法 pushTime 一律 PARAM_INVALID（25:00 / 9:5 / 空串 / 非字符串 / 非字符串类型）', async () => {
    // 业务错误按项目 Result 约定走 HTTP 200 + code≠0（handleError 对 BusinessException 的映射），
    // 不是 4xx；且必须落 PARAM_INVALID 具体码而不是 INTERNAL_ERROR——否则前端只能弹「系统错误」。
    for (const bad of ['25:00', '9:5', '', 'abc', 930, null]) {
      const { app, repo } = buildApp();
      try {
        const res = await app.inject({ method: 'PATCH', url: '/v1/digest/preferences', payload: { pushTime: bad } });
        const body = JSON.parse(res.body);
        expect(body.code).toBe(ErrorCode.PARAM_INVALID.code);
        // 校验不过不得落库
        expect(repo.upsertPreference).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it('PATCH enabled / outboundEnabled 非布尔拒绝，不落库', async () => {
    for (const payload of [{ enabled: 'yes' }, { outboundEnabled: 1 }, { enabled: null }]) {
      const { app, repo } = buildApp();
      try {
        const res = await app.inject({ method: 'PATCH', url: '/v1/digest/preferences', payload });
        expect(JSON.parse(res.body).code).not.toBe(0);
        expect(repo.upsertPreference).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });

  it('PATCH 合法值增量合并：只传 pushTime 不动 enabled/outboundEnabled', async () => {
    const { app, repo } = buildApp();
    try {
      const res = await app.inject({ method: 'PATCH', url: '/v1/digest/preferences', payload: { pushTime: '08:15' } });
      expect(JSON.parse(res.body).code).toBe(0);
      expect(repo.upsertPreference).toHaveBeenCalledWith({
        userId: 7,
        enabled: true,
        pushTime: '08:15',
        outboundEnabled: true,
      });
    } finally {
      await app.close();
    }
  });

  it('POST /v1/digest/send-now 走 force 链路：写收件箱 + 不写 last_digest_date', async () => {
    const { app, repo, inbox, outbound } = buildApp();
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/digest/send-now' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.sent).toBe(true);
      expect(body.data.coveredDate).toBe(YESTERDAY);
      expect(body.data.line).toContain('完成 3');
      expect(inbox.writeDigestEntry).toHaveBeenCalledTimes(1);
      expect(outbound.dispatchDigest).toHaveBeenCalledTimes(1);
      // 试发绝不推进 last_digest_date：否则当天调度会跳过正式推送
      expect(repo.markProcessed).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('send-now 安静日返回 sent=false + reason=QUIET，不写收件箱', async () => {
    const { app, inbox } = buildApp({
      repo: {
        countTaskTerminal: vi.fn(async () => ({ completed: 0, failed: 0 })),
        sumCostByAgent: vi.fn(async () => []),
      },
    });
    try {
      const res = await app.inject({ method: 'POST', url: '/v1/digest/send-now' });
      const body = JSON.parse(res.body);
      expect(body.data).toMatchObject({ sent: false, reason: 'QUIET', coveredDate: YESTERDAY });
      expect(inbox.writeDigestEntry).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('busyData 形状守卫：六板块字段齐备（聚合漏字段时渲染端会静默缺席）', () => {
    const data = busyData();
    expect(Object.keys(data).sort()).toEqual(['approvals', 'cost', 'coveredDate', 'openApi', 'scheduled', 'tasks', 'watchers']);
  });
});
