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
import { SessionExportService, sanitizeExportFileName } from './session-export.service.js';
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
      render: vi.fn(async () => ({
        filename: '排查登录-20261007.jsonl',
        jsonl: `${JSON.stringify({ type: 'session_export', messageCount: 1 })}\n${JSON.stringify({ id: 8, role: 'USER', content: '结论' })}\n`,
      })),
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
    const tooBig = await fastify.inject({ method: 'GET', url: '/v1/sessions/11/export/jsonl' });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().code).toBe(ErrorCode.EXPORT_TOO_LARGE.code);

    const ok = await fastify.inject({ method: 'GET', url: '/v1/sessions/11/export/jsonl' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/x-ndjson');
    expect(String(ok.headers['content-disposition'])).toContain('filename*=UTF-8');
    const lines = ok.body.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0].type).toBe('session_export');
    expect(lines[1]).toMatchObject({ role: 'USER', content: '结论' });
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

describe('session jsonl export', () => {
  function parseLines(jsonl: string): Record<string, unknown>[] {
    return jsonl.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('首行元信息头 + 每行原始消息，字段与压缩归档一致，thinking 与图片不出现', async () => {
    const toolCalls = JSON.stringify([
      { name: 'shell', summary: '已有摘要', input: { command: 'ignored' } },
      { name: 'shell', input: { command: 'x'.repeat(80) } },
      { name: 'search', input: { query: 'login error' } },
    ]);
    const sessionService = {
      getMessagesByRounds: vi.fn()
        .mockResolvedValueOnce({
          // selectRange 按 id 升序返回，逐页 unshift 后整体仍是时间正序
          messages: [
            {
              id: 1,
              sessionId: 11,
              role: 'USER',
              content: JSON.stringify([{ type: 'text', text: '请修登录' }, { type: 'image_url', image_url: { url: 'http://img/a.png' } }]),
            },
            { id: 2, sessionId: 11, role: 'ASSISTANT', content: '最终结论正文', thinkingContent: 'SECRET_THINKING', toolCalls },
          ],
          hasMore: true,
          nextBeforeMessageId: 1,
        })
        .mockResolvedValueOnce({
          messages: [{ id: 0, sessionId: 11, role: 'USER', content: '更早的一句' }],
          hasMore: false,
          nextBeforeMessageId: null,
        }),
      listFileChangeSummaries: vi.fn(async () => [
        { messageId: 2, filePath: 'a.ts', changeType: 'CREATED', linesAdded: 3, linesDeleted: 0 },
        { messageId: 2, filePath: 'a.ts', changeType: 'MODIFIED', linesAdded: 1, linesDeleted: 2 },
      ]),
    };
    const exporter = new SessionExportService(sessionService as never, {
      findById: async () => ({ id: 3, name: '排查员' }),
    } as never, 1024 * 1024);
    const result = await exporter.render(session(), new Date('2026-10-07T01:02:03Z'));
    const [header, ...lines] = parseLines(result.jsonl);
    expect(header).toMatchObject({
      type: 'session_export',
      schemaVersion: 1,
      exportedAt: '2026-10-07 09:02:03',
      messageCount: 3,
      userRoundCount: 2,
    });
    expect(header.session).toMatchObject({ id: 11, title: '排查登录', sessionType: 'NORMAL', agentName: '排查员' });
    expect(header.fileChanges).toEqual([{ path: 'a.ts', type: 'MODIFIED', linesAdded: 4, linesDeleted: 2 }]);
    // 行字段与 compaction-NNN.jsonl 完全一致，且不含 thinkingContent
    expect(lines[0]).toEqual({
      id: 0,
      role: 'USER',
      content: '更早的一句',
      toolCallId: null,
      toolCalls: null,
      metadata: null,
      tokenCount: null,
      modelId: null,
      createdAt: null,
    });
    // 多模态 content 原样保留（压缩归档同口径），不做 text 抽取
    const multimodal = JSON.stringify([
      { type: 'text', text: '请修登录' },
      { type: 'image_url', image_url: { url: 'http://img/a.png' } },
    ]);
    expect(lines[1]).toMatchObject({ id: 1, role: 'USER', content: multimodal });
    expect(lines[2]).toMatchObject({ id: 2, role: 'ASSISTANT', content: '最终结论正文' });
    expect(JSON.stringify(lines[2])).not.toContain('SECRET_THINKING');
    // fileChanges summary 挂在对应消息上，按 messageId 关联；同文件多条变更逐条保留
    expect(lines[2].fileChanges).toEqual([
      { path: 'a.ts', type: 'CREATED', linesAdded: 3, linesDeleted: 0 },
      { path: 'a.ts', type: 'MODIFIED', linesAdded: 1, linesDeleted: 2 },
    ]);
    expect(lines[1].fileChanges).toBeUndefined();
    expect(result.filename.endsWith('.jsonl')).toBe(true);
  });

  it('持久化的 function 风格 tool_calls 与 markdown 预览 fallback 不再参与渲染', async () => {
    // 行直接透传 toolCalls 原文，summary / 极简预览之类文本加工全部取消
    const persisted = JSON.stringify([
      { id: 'c1', function: { name: 'shell', arguments: JSON.stringify({ command: 'npm test' }) } },
      { id: 'c2', function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/a.ts' }) } },
    ]);
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 3, sessionId: 11, role: 'ASSISTANT', content: 'done', toolCalls: persisted }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => []),
    };
    const result = await new SessionExportService(sessionService as never, { findById: async () => null } as never)
      .render(session());
    const [, line] = parseLines(result.jsonl);
    expect(line.toolCalls).toBe(persisted);
  });

  it('内联图片 base64 替换为占位符，原图路径留在 metadata.attachments', async () => {
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{
          id: 5,
          sessionId: 11,
          role: 'TOOL',
          content: '截图 data:image/png;base64,QUJD',
          metadata: JSON.stringify({ attachments: [{ mime: 'image/png', path: 'out/a.png', data_uri: 'data:image/png;base64,QUJD' }] }),
        }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => []),
    };
    const result = await new SessionExportService(sessionService as never, { findById: async () => null } as never)
      .render(session());
    const [, line] = parseLines(result.jsonl);
    expect(line.content).toBe('截图 [image data URI omitted: image/png]');
    const meta = JSON.parse(line.metadata as string) as { attachments: Array<Record<string, string>> };
    expect(meta.attachments[0]).toMatchObject({ mime: 'image/png', path: 'out/a.png' });
    expect(meta.attachments[0].data_uri).toBe('[image data URI omitted: image/png]');
  });

  it('文件名按码点截断，emoji 标题不切出孤立代理项', () => {
    // 79 个 ASCII + 1 个 emoji = 80 码点但占 81 个 UTF-16 码元，
    // 旧实现 slice(0,80) 在此切出孤立高代理项，encodeURIComponent 抛 URIError → 端点 500。
    // 按码点计算时这 80 点应完整保留。
    const straddle = sanitizeExportFileName('A'.repeat(79) + '\u{1F600}', new Date('2026-10-07T00:00:00Z'));
    expect(straddle).toBe(`${'A'.repeat(79)}\u{1F600}-20261007.jsonl`);
    expect(() => encodeURIComponent(straddle)).not.toThrow();
    // 码点数超过上限时整体丢掉超出的字符，而不是留下半个代理对
    const over = sanitizeExportFileName('B'.repeat(80) + '\u{1F600}', new Date('2026-10-07T00:00:00Z'));
    expect(over).toBe(`${'B'.repeat(80)}-20261007.jsonl`);
    expect(() => encodeURIComponent(over)).not.toThrow();
  });

  it('文件名去掉路径分隔符与控制字符，超限抛出 EXPORT_TOO_LARGE', async () => {
    expect(sanitizeExportFileName('a/b\\c\u0000d', new Date('2026-10-07T00:00:00Z'))).toMatch(/^a_b_cd-\d{8}\.jsonl$/);
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [{ id: 1, sessionId: 11, role: 'USER', content: 'y'.repeat(80) }],
        hasMore: false,
        nextBeforeMessageId: null,
      })),
      listFileChangeSummaries: vi.fn(async () => []),
    };
    const exporter = new SessionExportService(sessionService as never, { findById: async () => null } as never, 40);
    await expect(exporter.render(session())).rejects.toMatchObject({ code: ErrorCode.EXPORT_TOO_LARGE.code });
  });

  it('边路导出不含父会话副本，只挂边路自己的消息与文件变更', async () => {
    const sessionService = {
      getMessagesByRounds: vi.fn(async () => ({
        messages: [
          { id: 1, sessionId: 11, role: 'USER', content: '父会话里的密钥 sk-parent-secret', sourceSessionId: 99 },
          { id: 2, sessionId: 11, role: 'ASSISTANT', content: '父会话回答', sourceSessionId: 99 },
          { id: 3, sessionId: 11, role: 'USER', content: '边路自己的问题', sourceSessionId: null },
          { id: 4, sessionId: 11, role: 'ASSISTANT', content: '边路自己的回答', sourceSessionId: null },
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
    const [header, ...lines] = parseLines(result.jsonl);
    expect(header.session).toMatchObject({ sessionType: 'SIDE_TASK', parentSessionId: 99 });
    expect(lines.map((line) => line.content)).toEqual(['边路自己的问题', '边路自己的回答']);
    expect(JSON.stringify(result.jsonl)).not.toContain('sk-parent-secret');
    expect(lines[1].fileChanges).toEqual([{ path: 'side-own.ts', type: 'MODIFIED', linesAdded: 2, linesDeleted: 1 }]);
    expect(sessionService.getMessagesByRounds).toHaveBeenCalledWith(11, 50, null, { excludeSourceSessionId: 99 });
  });
});
