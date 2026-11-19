// 钉钉密码绑定路由：pending 预览 / complete 四档结局 / 幂等 / TTL（expires_at 列）/ 401（§8）。
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerDingtalkBindingRoutes, type DingtalkBindingRouteDeps } from './binding.routes.js';
import type { DingtalkPendingBindingMessage } from './pending-binding.repository.js';

const USER_ID = 9;
const TOKEN = 'tok-9';

function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    state: 'st-1',
    botId: 2,
    status: 'SENT',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString().replace('T', ' ').slice(0, 19),
    event: {
      chatType: 'p2p', conversationId: 'cid-1', messageId: 'm1',
      senderUserid: 'staff_1', senderUnionId: 'du_1', senderName: '钉钉张三',
      msgtype: 'text', text: 'hi', downloadCodes: [], fileName: null, quotedText: null, isInAtList: false,
    },
    ...overrides,
  } as unknown as DingtalkPendingBindingMessage & { expiresAt?: string | null };
}

function setup(options: { row?: Record<string, unknown> | null; existingOwner?: number | null; replayThrows?: boolean; disabled?: boolean; bindThrows?: boolean } = {}) {
  const pending = {
    findByState: vi.fn(async () => (options.row === undefined ? pendingRow() : options.row) as never),
    claim: vi.fn(async () => (options.row === undefined ? pendingRow({ status: 'CLAIMED' }) : null) as never),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    markSent: vi.fn(async () => undefined),
  };
  const repository = {
    getStatus: vi.fn(async () => ({ bound: false })),
    findUserIdByUnionId: vi.fn(async () => options.existingOwner ?? null),
    bind: vi.fn(async () => {
      if (options.bindThrows === true) throw new Error('钉钉身份不完整，无法绑定');
    }),
  };
  const replayPending = vi.fn(async () => {
    if (options.replayThrows === true) throw new Error('replay boom');
  });
  const app = Fastify();
  app.setErrorHandler(handleError);
  const deps: DingtalkBindingRouteDeps = {
    jwt: { validateAccessToken: (t: string) => t === TOKEN, getUserIdFromToken: () => USER_ID } as never,
    repository: repository as never,
    oauthStates: {} as never,
    oauth: vi.fn(async () => ({ enabled: false, clientId: '', clientSecret: '', redirectUri: '' })) as never,
    onCallback: vi.fn(async () => undefined) as never,
    pending: pending as never,
    currentUser: vi.fn(async (userId: number) => ({ id: userId, username: 'bob', disabled: options.disabled === true })),
    replayPending: replayPending as never,
  };
  registerDingtalkBindingRoutes(app, deps);
  const authed = { authorization: `Bearer ${TOKEN}` };
  return { app, deps, pending, repository, replayPending, authed };
}

describe('钉钉密码绑定路由', () => {
  it('预览：返回双方身份与 willRebind / expiresAt', async () => {
    const { app, authed } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1', headers: authed });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(0);
    expect(res.json().data.senderName).toBe('钉钉张三');
    expect(res.json().data.chatType).toBe('p2p');
    expect(res.json().data.currentUser.username).toBe('bob');
    expect(res.json().data.willRebind).toBe(false);
    expect(res.json().data.expiresAt).toBeTruthy();
  });

  it('预览：state 不存在 / 已过期返回业务错误', async () => {
    const { app, authed, pending } = setup({ row: null });
    const res = await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1', headers: authed });
    expect(res.json().code).not.toBe(0);
    expect(res.json().message).toContain('链接已过期或已使用');
    expect(pending.claim).not.toHaveBeenCalled();
  });

  it('预览：账号禁用拒绝（§4.6）', async () => {
    const { app, authed } = setup({ disabled: true });
    const res = await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1', headers: authed });
    expect(res.json().code).not.toBe(0);
    expect(res.json().message).toContain('账号已禁用');
  });

  it('未登录调预览 / complete 401', async () => {
    const { app } = setup();
    expect((await app.inject({ method: 'GET', url: '/v1/dingtalk/binding/pending?state=st-1' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' } })).statusCode).toBe(401);
  });

  it('complete：成功档（bind 带 senderUserid 第三参 + 补投 + 置 COMPLETED）', async () => {
    const { app, authed, repository, pending } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data).toEqual({ status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '钉钉张三' });
    expect(repository.bind).toHaveBeenCalledWith(USER_ID, 'du_1', 'staff_1');
    expect(pending.complete).toHaveBeenCalledWith('st-1');
  });

  it('complete：身份冲突档（unionId 已属其它账号）', async () => {
    const { app, authed, repository, replayPending } = setup({ existingOwner: 3 });
    const res = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('failed');
    expect(res.json().data.message).toContain('该钉钉身份已绑定其它 Mao 账号');
    expect(repository.bind).not.toHaveBeenCalled();
    expect(replayPending).not.toHaveBeenCalled();
  });

  it('complete：bind 抛错时释放回 SENT 并整体失败（不留死锁 CLAIMED）', async () => {
    const { app, authed, pending, replayPending } = setup({ bindThrows: true });
    const res = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.statusCode).toBe(500);
    expect(pending.release).toHaveBeenCalledWith('st-1');
    expect(replayPending).not.toHaveBeenCalled();
  });

  it('complete：补投失败档 partial（release 回 SENT）', async () => {
    const { app, authed, pending } = setup({ replayThrows: true });
    const res = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('partial');
    expect(pending.release).toHaveBeenCalledWith('st-1');
  });

  it('complete：no-pending 档 failed（幂等）', async () => {
    const { app, authed, pending } = setup();
    const first = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(first.json().data.status).toBe('success');
    pending.findByState.mockResolvedValue(null as never);
    const second = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(second.json().data.status).toBe('failed');
    expect(pending.claim).toHaveBeenCalledTimes(1);
  });

  it('complete：账号禁用返回 failed', async () => {
    const { app, authed, pending } = setup({ disabled: true });
    const res = await app.inject({ method: 'POST', url: '/v1/dingtalk/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('failed');
    expect(res.json().data.message).toContain('账号已禁用');
    expect(pending.claim).not.toHaveBeenCalled();
  });
});
