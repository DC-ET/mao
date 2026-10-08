import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { handleError } from '../common/http-error.js';
import { formatDateTime } from '../common/json.js';
import type { AuditLog } from '../audit/types.js';
import type { SessionShareRow, SessionShareStore } from './session-share.repository.js';
import { MysqlSessionShareRepository } from './session-share.repository.js';
import type { Message, MessagePage } from './types.js';
import { SessionExportService, fallbackToolInputPreview, sanitizeExportFileName } from './session-export.service.js';
import { SessionShareService } from './session-share.service.js';
import { registerSessionShareRoutes } from './session-share.routes.js';
import type { Session } from './types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 11,
    userId: 7,
    agentId: 3,
    title: '排查登录',
    sessionType: 'NORMAL',
    createdAt: '2026-10-06 09:00:00',
    ...overrides,
  };
}

class MemoryShareStore implements SessionShareStore {
  rows: SessionShareRow[] = [];
  private nextId = 1;
  private chain: Promise<void> = Promise.resolve();
  failInserts = 0;

  transaction<T>(fn: (tx: SessionShareStore) => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const prev = this.chain;
    this.chain = new Promise((resolve) => { release = resolve; });
    return prev.then(async () => {
      try {
        return await fn(this);
      } finally {
        release();
      }
    });
  }

  async lockBySession(sessionId: number): Promise<SessionShareRow[]> {
    return this.rows.filter((row) => row.sessionId === sessionId);
  }

  async findActiveBySession(sessionId: number): Promise<SessionShareRow | null> {
    return this.rows.filter((row) => row.sessionId === sessionId && row.revokedAt == null).at(-1) ?? null;
  }

  async findByToken(token: string): Promise<SessionShareRow | null> {
    return this.rows.find((row) => row.shareToken === token) ?? null;
  }

  async insert(row: {
    sessionId: number;
    shareToken: string;
    messageWatermark: number;
    createdBy: number;
    viewCount: number;
    expiresAt?: string | null;
  }): Promise<number> {
    if (this.failInserts > 0) {
      this.failInserts -= 1;
      const err = new Error('dup') as Error & { code: string };
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    if (this.rows.some((item) => item.shareToken === row.shareToken)) {
      const err = new Error('dup') as Error & { code: string };
      err.code = 'ER_DUP_ENTRY';
      throw err;
    }
    const id = this.nextId++;
    this.rows.push({
      id,
      sessionId: row.sessionId,
      shareToken: row.shareToken,
      messageWatermark: row.messageWatermark,
      createdBy: row.createdBy,
      viewCount: row.viewCount,
      expiresAt: row.expiresAt ?? null,
      revokedAt: null,
      createdAt: '2026-10-07 10:00:00',
    });
    return id;
  }

  async updateWatermark(id: number, watermark: number): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row && row.revokedAt == null) row.messageWatermark = watermark;
  }

  async revoke(id: number, revokedAt: string): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row && row.revokedAt == null) row.revokedAt = revokedAt;
  }

  async incrementView(id: number): Promise<void> {
    const row = this.rows.find((item) => item.id === id);
    if (row) row.viewCount += 1;
  }
}

function harness(options?: { enabled?: boolean; maxId?: number }) {
  const store = new MemoryShareStore();
  const audits: AuditLog[] = [];
  let maxId = options?.maxId ?? 20;
  const sessionService = {
    getSession: vi.fn(async () => session()),
    getMaxMessageId: vi.fn(async () => maxId),
    getMessagesByRounds: vi.fn(async (): Promise<MessagePage> => ({
      messages: [{
        id: 8,
        sessionId: 11,
        role: 'ASSISTANT',
        content: '结论',
        thinkingContent: '内部推理',
        toolCalls: JSON.stringify([{ name: 'shell', summary: '跑了测试', input: { command: 'npm test' } }]),
      }],
      hasMore: false,
      nextBeforeMessageId: null,
    })),
    getFileChangeSummariesByMessageIds: vi.fn(async () => new Map()),
    listFileChangeSummaries: vi.fn(async () => []),
  };
  const users = {
    findById: vi.fn(async () => ({ id: 7, username: 'ada', displayName: 'Ada', status: 1, deleted: 0 })),
  };
  const agents = {
    findById: vi.fn(async () => ({ id: 3, name: '排查员' })),
    findByIds: vi.fn(async () => []),
    requireDefaultAgent: vi.fn(async () => ({ id: 3, name: '排查员' })),
    listOptions: vi.fn(async () => []),
  };
  const service = new SessionShareService(
    store,
    sessionService as never,
    users as never,
    agents,
    { record: async (log) => { audits.push(log); return 1; } },
    async () => options?.enabled ?? false,
  );
  return {
    store,
    audits,
    sessionService,
    users,
    service,
    setMaxId(value: number) { maxId = value; },
  };
}

describe('session share service', () => {
  it('创建幂等、token 为 64 hex，边路任务也可分享', async () => {
    const { service, store, audits } = harness();
    const first = await service.create(session({ sessionType: 'SIDE_TASK' }), 7);
    const second = await service.create(session({ sessionType: 'SIDE_TASK' }), 7);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.token).toBe(first.token);
    expect(store.rows).toHaveLength(1);
    expect(audits.map((item) => item.action)).toEqual(['CREATE']);
    expect(audits[0].objectType).toBe('session.share');
    expect(audits[0].objectId).toBe(`${first.token.slice(0, 8)}:${store.rows[0].id}`);
  });

  it('并发创建只产生一条活跃分享', async () => {
    const { service, store } = harness();
    const [a, b] = await Promise.all([
      service.create(session(), 7),
      service.create(session(), 7),
    ]);
    expect(a.token).toBe(b.token);
    expect(store.rows.filter((row) => row.revokedAt == null)).toHaveLength(1);
  });

  it('token 唯一键冲突会换 token 重试', async () => {
    const { service, store } = harness();
    store.failInserts = 1;
    const created = await service.create(session(), 7);
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(store.rows).toHaveLength(1);
  });

  it('刷新水位可前进也可在截断后回落', async () => {
    const h = harness({ maxId: 30 });
    const created = await h.service.create(session(), 7);
    expect(created.messageWatermark).toBe(30);
    h.setMaxId(12);
    const refreshed = await h.service.refresh(11);
    expect(refreshed.messageWatermark).toBe(12);
    expect(h.store.rows[0].messageWatermark).toBe(12);
  });

  it('撤销后 token 失效，重复撤销不再记审计', async () => {
    const { service, audits } = harness();
    const created = await service.create(session(), 7);
    await service.revoke(11, 7);
    await expect(service.readView(created.token, 5, null, 8, '/v1/share/x')).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    await service.revoke(11, 7);
    expect(audits.map((item) => item.action)).toEqual(['CREATE', 'DELETE']);
  });

  it('校验链各失败原因都是同一个 SHARE_NOT_FOUND', async () => {
    const h = harness();
    const created = await h.service.create(session(), 7);
    const expectMissing = async (prepare: () => void) => {
      prepare();
      await expect(h.service.readView(created.token, 5, null, 9, '/v1/share/x')).rejects.toMatchObject({
        code: ErrorCode.SHARE_NOT_FOUND.code,
        message: ErrorCode.SHARE_NOT_FOUND.message,
      });
    };
    await expect(h.service.readView('ab'.repeat(32), 5, null, 9, '/v1/share/x')).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    h.store.rows[0].expiresAt = '2000-01-01 00:00:00';
    await expectMissing(() => {});
    h.store.rows[0].expiresAt = null;
    h.store.rows[0].revokedAt = '2026-10-07 11:00:00';
    await expect(h.service.readView(created.token, 5, null, 9, '/v1/share/x')).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    h.store.rows[0].revokedAt = null;
    h.sessionService.getSession.mockRejectedValueOnce(new BusinessException(ErrorCode.SESSION_NOT_FOUND));
    await expect(h.service.readView(created.token, 5, null, 9, '/v1/share/x')).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    h.users.findById.mockResolvedValueOnce({ id: 7, username: 'ada', displayName: 'Ada', status: 0, deleted: 0 });
    await expect(h.service.readView(created.token, 5, null, 9, '/v1/share/x')).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
  });

  it('水位截断、剥离 thinking，仅首页计数与 READ 审计', async () => {
    const h = harness();
    const created = await h.service.create(session(), 7);
    h.sessionService.getMessagesByRounds.mockResolvedValue({
      messages: [{
        id: 4,
        sessionId: 11,
        role: 'USER',
        content: '新内容',
        thinkingContent: '不要泄漏',
        toolCalls: null,
      }],
      hasMore: true,
      nextBeforeMessageId: 4,
    });
    const view = await h.service.readView(created.token, 5, null, 9, `/v1/share/${created.token}`);
    expect(h.sessionService.getMessagesByRounds).toHaveBeenCalledWith(11, 5, null, {
      maxMessageId: created.messageWatermark,
      excludeSourceSessionId: null,
    });
    expect(view.messages[0].content).toBe('新内容');
    expect(view.messages[0].thinkingContent).toBeNull();
    expect(view.share.viewCount).toBe(0);
    expect(h.store.rows[0].viewCount).toBe(1);
    await h.service.readView(created.token, 5, 4, 9, '/v1/share/tok');
    expect(h.store.rows[0].viewCount).toBe(1);
    expect(view.hasMore).toBe(true);
    expect(view.nextBeforeMessageId).toBe(4);
    expect(view.session).toMatchObject({ id: 11, agentName: '排查员', ownerName: 'Ada', sessionType: 'NORMAL' });
    expect(view.share).not.toHaveProperty('token');
    expect(h.audits.filter((item) => item.action === 'READ')).toHaveLength(1);
    expect(h.audits.find((item) => item.action === 'READ')?.path).toBe('/v1/share/{token}');
    expect(h.audits.find((item) => item.action === 'READ')?.path).not.toContain(created.token);
  });

  it('边路分享去掉父会话副本，大写 token 不进审计 path', async () => {
    const h = harness();
    h.sessionService.getSession.mockResolvedValue(session({ sessionType: 'SIDE_TASK', parentSessionId: 99 }));
    h.sessionService.getMessagesByRounds.mockResolvedValue({
      messages: [
        { id: 1, sessionId: 11, role: 'USER', content: '父会话里的密钥', thinkingContent: null, toolCalls: null, sourceSessionId: 99 },
        { id: 2, sessionId: 11, role: 'ASSISTANT', content: '父会话回答', thinkingContent: null, toolCalls: null, sourceSessionId: 99 },
        { id: 3, sessionId: 11, role: 'USER', content: '边路自己的问题', thinkingContent: null, toolCalls: null, sourceSessionId: null },
        { id: 4, sessionId: 11, role: 'ASSISTANT', content: '边路自己的回答', thinkingContent: null, toolCalls: null, sourceSessionId: null },
      ],
      hasMore: false,
      nextBeforeMessageId: null,
    });
    const created = await h.service.create(session({ sessionType: 'SIDE_TASK', parentSessionId: 99 }), 7);
    const view = await h.service.readView(created.token, 5, null, 9, `/v1/share/${created.token.toUpperCase()}`);
    expect(h.sessionService.getMessagesByRounds).toHaveBeenCalledWith(11, 5, null, {
      maxMessageId: created.messageWatermark,
      excludeSourceSessionId: 99,
    });
    expect(view.messages.map((message) => message.content)).toEqual(['边路自己的问题', '边路自己的回答']);
    expect(h.audits.find((item) => item.action === 'READ')?.path).toBe('/v1/share/{token}');
  });

  it('匿名链接在开关关闭时拒绝，开启后写入过期时间', async () => {
    const closed = harness({ enabled: false });
    await expect(closed.service.create(session(), 7, { publicLink: true, expiresInDays: 3 })).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
    });
    const opened = harness({ enabled: true });
    const created = await opened.service.create(session(), 7, { publicLink: true, expiresInDays: 3 });
    expect(created.expiresAt).toBeTruthy();
    expect(opened.store.rows[0].expiresAt).toBeTruthy();
  });

  it('过期按上海墙钟判定，公开端点不接受登录链接', async () => {
    const h = harness({ enabled: true });
    const login = await h.service.create(session(), 7);
    await expect(h.service.readView(login.token, 5, null, null, '/v1/share/public/x', true)).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    const pub = await h.service.create(session({ id: 12 }), 7, { publicLink: true, expiresInDays: 1 });
    h.store.rows.find((row) => row.shareToken === pub.token)!.expiresAt = formatDateTime(new Date(Date.now() - 60_000));
    await expect(h.service.readView(pub.token, 5, null, null, '/v1/share/public/x', true)).rejects.toMatchObject({
      code: ErrorCode.SHARE_NOT_FOUND.code,
    });
    const live = await h.service.create(session({ id: 13 }), 7, { publicLink: true, expiresInDays: 1 });
    const view = await h.service.readView(live.token, 5, null, null, `/v1/share/public/${live.token}`, true);
    expect(view.messages).toHaveLength(1);
    expect(view.share.viewCount).toBe(0);
    expect(h.audits.find((item) => item.action === 'READ')?.path).toBe('/v1/share/public/{token}');
  });
});

describe('session share routes', () => {
  async function app(userId: number | null, enabled = false) {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    if (userId != null) {
      fastify.addHook('preHandler', (req, _reply, done) => {
        (req as { userId?: number }).userId = userId;
        done();
      });
    }
    const shareService = {
      create: vi.fn(async () => ({ token: 'a'.repeat(64), messageWatermark: 1, viewCount: 0, createdAt: null, expiresAt: null, lastViewedAt: null })),
      refresh: vi.fn(async () => ({ token: 'a'.repeat(64), messageWatermark: 2, viewCount: 0, createdAt: null, expiresAt: null, lastViewedAt: null })),
      getActive: vi.fn(async () => null),
      revoke: vi.fn(async () => undefined),
      readView: vi.fn(async () => ({ session: { id: 11 }, share: {}, messages: [], hasMore: false, nextBeforeMessageId: null })),
    };
    const sessionService = {
      getSession: vi.fn(async (id: number) => session({ id, userId: 7 })),
    };
    const exportService = {
      render: vi.fn(async () => ({ filename: '排查登录-20261007.md', markdown: '# 排查登录\n' })),
    };
    await registerSessionShareRoutes(fastify, {
      sessionService: sessionService as never,
      shareService: shareService as never,
      exportService: exportService as never,
      tokenLinksEnabled: async () => enabled,
    });
    return { fastify, shareService, exportService };
  }

  it('未登录访问分享视图返回 401', async () => {
    const { fastify } = await app(null);
    const res = await fastify.inject({ method: 'GET', url: `/v1/share/${'ab'.repeat(32)}` });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(1001);
  });

  it('他人会话管理分享返回 403', async () => {
    const { fastify, shareService } = await app(8);
    const res = await fastify.inject({ method: 'POST', url: '/v1/sessions/11/share', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(shareService.create).not.toHaveBeenCalled();
  });

  it('属主可创建分享', async () => {
    const { fastify } = await app(7);
    const res = await fastify.inject({ method: 'POST', url: '/v1/sessions/11/share', payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(0);
    expect(res.json().data.token).toHaveLength(64);
  });

  it('开关关闭时创建匿名链接返回 400', async () => {
    const { fastify, shareService } = await app(7, false);
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/sessions/11/share',
      payload: { publicLink: true, expiresInDays: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(shareService.create).not.toHaveBeenCalled();
  });

  it('公开端点关闭时 404，开启后免登录可达，失效 404', async () => {
    const closed = await app(null, false);
    const hidden = await closed.fastify.inject({ method: 'GET', url: `/v1/share/public/${'cd'.repeat(32)}` });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: 'not found' });
    expect(closed.shareService.readView).not.toHaveBeenCalled();

    const opened = await app(null, true);
    const ok = await opened.fastify.inject({ method: 'GET', url: `/v1/share/public/${'cd'.repeat(32)}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().code).toBe(0);

    opened.shareService.readView.mockRejectedValueOnce(new BusinessException(ErrorCode.SHARE_NOT_FOUND));
    const gone = await opened.fastify.inject({ method: 'GET', url: `/v1/share/public/${'cd'.repeat(32)}` });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: 'not found' });
  });

  it('公开端点内部故障也归一为 404，不回传错误信封', async () => {
    const { fastify, shareService } = await app(null, true);
    shareService.readView.mockRejectedValueOnce(new Error('pool exhausted'));
    const res = await fastify.inject({ method: 'GET', url: `/v1/share/public/${'cd'.repeat(32)}` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not found' });
    expect(res.body).not.toContain('pool exhausted');
  });

  it('导出超限返回 413，成功时带附件头', async () => {
    const { fastify, exportService } = await app(7);
    exportService.render.mockRejectedValueOnce(new BusinessException(ErrorCode.EXPORT_TOO_LARGE));
    const tooBig = await fastify.inject({ method: 'GET', url: '/v1/sessions/11/export/markdown' });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().code).toBe(ErrorCode.EXPORT_TOO_LARGE.code);

    const ok = await fastify.inject({ method: 'GET', url: '/v1/sessions/11/export/markdown' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/markdown');
    expect(String(ok.headers['content-disposition'])).toContain('filename*=UTF-8');
    expect(ok.body).toContain('# 排查登录');
  });

  it('分享行锁定 SQL 使用 FOR UPDATE', async () => {
    const calls: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        return [];
      }),
    };
    const repo = new MysqlSessionShareRepository(db as never);
    await repo.lockBySession(11);
    expect(calls[0]).toContain('FOR UPDATE');
    expect(calls[0]).toContain('session_id');
  });
});

describe('session markdown export', () => {
  it('模板四节、复用 summary、空摘要回退、thinking 与图片不出现、步骤截断', async () => {
    const longCommand = 'x'.repeat(80);
    const calls = [
      { name: 'shell', summary: '已有摘要', input: { command: 'ignored' } },
      { name: 'shell', input: { command: longCommand } },
      { name: 'search', input: { query: 'login error' } },
    ];
    const extra = Array.from({ length: 499 }, (_, index) => ({ name: 'shell', summary: `步骤${index}` }));
    const sessionService = {
      getMessagesByRounds: vi.fn()
        .mockResolvedValueOnce({
          messages: [
            { id: 2, role: 'ASSISTANT', content: '最终结论正文', thinkingContent: 'SECRET_THINKING', toolCalls: JSON.stringify([...calls, ...extra]) },
            { id: 1, role: 'USER', content: JSON.stringify([{ type: 'text', text: '请修登录' }, { type: 'image_url', image_url: { url: 'http://img/a.png' } }]) },
          ],
          hasMore: true,
          nextBeforeMessageId: 1,
        })
        .mockResolvedValueOnce({
          messages: [{ id: 1, role: 'USER', content: '更早的一句' }],
          hasMore: false,
          nextBeforeMessageId: null,
        }),
      listFileChangeSummaries: vi.fn(async () => [
        { filePath: 'a.ts', changeType: 'CREATED', linesAdded: 3, linesDeleted: 0 },
        { filePath: 'a.ts', changeType: 'MODIFIED', linesAdded: 1, linesDeleted: 2 },
      ]),
    };
    const exporter = new SessionExportService(sessionService as never, {
      findById: async () => ({ id: 3, name: '排查员' }),
    } as never, 1024 * 1024);
    const result = await exporter.render(session(), new Date('2026-10-07T01:02:03Z'));
    expect(result.markdown).toContain('# 排查登录');
    expect(result.markdown).toContain('元信息：Agent 排查员');
    expect(result.markdown).toContain('消息轮数 2');
    expect(result.markdown).toContain('## 任务目标');
    expect(result.markdown).toContain('更早的一句');
    expect(result.markdown).toContain('## 最终结论');
    expect(result.markdown).toContain('最终结论正文');
    expect(result.markdown).toContain('## 关键步骤');
    expect(result.markdown).toContain('- 已有摘要');
    expect(result.markdown).toContain(`- ${'x'.repeat(60)}...`);
    expect(result.markdown).toContain('- login error');
    const persisted = JSON.stringify([
      { id: 'c1', function: { name: 'shell', arguments: JSON.stringify({ command: 'npm test' }) } },
      { id: 'c2', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) } },
      { id: 'c3', function: { name: 'web_search', arguments: JSON.stringify({ query: 'login error' }) } },
    ]);
    const persistedService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 3, role: 'ASSISTANT', content: 'done', toolCalls: persisted }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => []),
    };
    const persistedExport = await new SessionExportService(
      persistedService as never,
      { findById: async () => null } as never,
    ).render(session());
    expect(persistedExport.markdown).toContain('- npm test');
    expect(persistedExport.markdown).toContain('- src/a.ts');
    expect(persistedExport.markdown).toContain('- login error');
    expect(result.markdown).toContain('仅展示前 500 条');
    expect(result.markdown).toContain('## 文件变更');
    expect(result.markdown).toContain('- a.ts MODIFIED +4 -2');
    expect(result.markdown).not.toContain('SECRET_THINKING');
    expect(result.markdown).not.toContain('http://img/a.png');
    expect(result.filename.endsWith('.md')).toBe(true);
  });

  it('文件名按码点截断，emoji 标题不切出孤立代理项', () => {
    // 79 个 ASCII + 1 个 emoji = 80 码点但占 81 个 UTF-16 码元，
    // 旧实现 slice(0,80) 在此切出孤立高代理项，encodeURIComponent 抛 URIError → 端点 500。
    // 按码点计算时这 80 点应完整保留。
    const straddle = sanitizeExportFileName('A'.repeat(79) + '😀', new Date('2026-10-07T00:00:00Z'));
    expect(straddle).toBe(`${'A'.repeat(79)}😀-20261007.md`);
    expect(() => encodeURIComponent(straddle)).not.toThrow();
    // 码点数超过上限时整体丢掉超出的字符，而不是留下半个代理对
    const over = sanitizeExportFileName('B'.repeat(80) + '😀', new Date('2026-10-07T00:00:00Z'));
    expect(over).toBe(`${'B'.repeat(80)}-20261007.md`);
    expect(() => encodeURIComponent(over)).not.toThrow();
  });

  it('文件名去掉路径分隔符与控制字符，超限抛出 EXPORT_TOO_LARGE', async () => {
    expect(sanitizeExportFileName('a/b\\c\u0000d', new Date('2026-10-07T00:00:00Z'))).toMatch(/^a_b_cd-\d{8}\.md$/);
    expect(fallbackToolInputPreview({ command: 'ls' })).toBe('ls');
    expect(fallbackToolInputPreview({ path: 'src/a.ts' })).toBe('src/a.ts');
    expect(fallbackToolInputPreview({ query: 'q' })).toBe('q');
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 1, role: 'USER', content: 'y'.repeat(80) }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => []),
    };
    const exporter = new SessionExportService(sessionService as never, { findById: async () => null } as never, 40);
    await expect(exporter.render(session())).rejects.toMatchObject({ code: ErrorCode.EXPORT_TOO_LARGE.code });
  });

  it('边路导出不含父会话副本，任务目标是边路自己的问题', async () => {
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [
          { id: 1, role: 'USER', content: '父会话里的密钥 sk-parent-secret', sourceSessionId: 99 },
          { id: 2, role: 'ASSISTANT', content: '父会话回答', sourceSessionId: 99 },
          { id: 3, role: 'USER', content: '边路自己的问题', sourceSessionId: null },
          { id: 4, role: 'ASSISTANT', content: '边路自己的回答', sourceSessionId: null },
        ],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => [
        { messageId: 2, filePath: 'parent-secret.ts', changeType: 'CREATED', linesAdded: 1, linesDeleted: 0 },
        { messageId: 4, filePath: 'side-own.ts', changeType: 'MODIFIED', linesAdded: 2, linesDeleted: 1 },
      ]),
    };
    const result = await new SessionExportService(sessionService as never, { findById: async () => null } as never)
      .render(session({ sessionType: 'SIDE_TASK', parentSessionId: 99 }));
    expect(result.markdown).toContain('边路自己的问题');
    expect(result.markdown).toContain('边路自己的回答');
    expect(result.markdown).toContain('side-own.ts');
    expect(result.markdown).not.toContain('sk-parent-secret');
    expect(result.markdown).not.toContain('父会话回答');
    expect(result.markdown).not.toContain('parent-secret.ts');
    expect(sessionService.getMessagesByRounds).toHaveBeenCalledWith(11, 50, null, { excludeSourceSessionId: 99 });
  });
});
