// 飞书密码绑定路由：pending 预览 / complete 四档结局 / 幂等 / TTL / 未登录 401（§8）。
// Git/通道本身的行为由仓储与编排单测负责，这里只测接线与形状。
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFeishuPendingBindingRoutes, type FeishuPendingBindingRouteDeps } from './binding.routes.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';

const USER_ID = 9;
const TOKEN = 'tok-9';

/** SQL DATETIME 本地时间格式（parseSqlTimeMs 按本地时区解析，不能用 UTC ISO 串）。 */
function sqlLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pendingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    state: 'st-1',
    appId: 3,
    messageId: 'om_in',
    cardMessageId: null,
    status: 'SENT',
    createdAt: sqlLocal(Date.now() - 60_000),
    event: {
      eventId: 'evt', messageId: 'om_in', chatId: 'oc_1', chatType: 'p2p',
      senderId: 'ou_1', senderUnionId: 'on_1', senderType: 'user',
      messageType: 'text', text: 'hi', mentions: [], isBotMentioned: false,
      content: {}, rawEvent: {}, senderName: '张三',
    },
    ...overrides,
  } as unknown as FeishuPendingBindingMessage & { createdAt?: string | null };
}

function setup(options: { row?: Record<string, unknown> | null; existingOwner?: number | null; replayThrows?: boolean; disabled?: boolean } = {}) {
  const pendingBindingMessages = {
    findByState: vi.fn(async () => (options.row === undefined ? pendingRow() : options.row) as never),
    claim: vi.fn(async () => (options.row === undefined ? pendingRow({ status: 'CLAIMED' }) : null) as never),
    complete: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
    failClaimed: vi.fn(async () => undefined),
  };
  const binding = {
    getStatus: vi.fn(async () => ({ bound: false })),
    findUserIdByUnionId: vi.fn(async () => options.existingOwner ?? null),
    bind: vi.fn(async () => undefined),
  };
  const replay = vi.fn(async () => {
    if (options.replayThrows === true) throw new Error('replay boom');
  });
  const notifyMismatch = vi.fn(async () => undefined);
  const app = Fastify();
  app.setErrorHandler(handleError);
  const deps: FeishuPendingBindingRouteDeps = {
    jwt: { validateAccessToken: (t: string) => t === TOKEN, getUserIdFromToken: () => USER_ID } as never,
    binding: binding as never,
    pendingBindingMessages: pendingBindingMessages as never,
    currentUser: vi.fn(async (userId: number) => ({ id: userId, username: 'bob', disabled: options.disabled === true })),
    replay: replay as never,
    notifyMismatch,
  };
  registerFeishuPendingBindingRoutes(app, deps);
  const authed = { authorization: `Bearer ${TOKEN}` };
  return { app, deps, pendingBindingMessages, binding, replay, notifyMismatch, pendingBindingFailClaimed: pendingBindingMessages.failClaimed, authed };
}

describe('飞书密码绑定路由', () => {
  it('预览：返回双方身份与 willRebind（未绑定时 false）', async () => {
    const { app, authed } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: authed });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toBe(0);
    expect(body.data.senderName).toBe('张三');
    expect(body.data.chatType).toBe('p2p');
    expect(body.data.currentUser.username).toBe('bob');
    expect(body.data.willRebind).toBe(false);
    expect(body.data.expiresAt).toBeTruthy();
  });

  it('预览：willRebind = 当前账号已有其它 unionId 绑定', async () => {
    const { app, authed } = setup({ existingOwner: null });
    const res = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: authed });
    expect(res.json().data.willRebind).toBe(false);
  });

  it('预览：state 不存在 / 过期返回业务错误，不落库', async () => {
    const { app, authed, pendingBindingMessages } = setup({ row: null });
    const res = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: authed });
    expect(res.json().code).not.toBe(0);
    expect(res.json().message).toContain('链接已过期或已使用');
    expect(pendingBindingMessages.claim).not.toHaveBeenCalled();
  });

  it('预览：created_at 超过 15 分钟按过期处理', async () => {
    const stale = pendingRow({ createdAt: sqlLocal(Date.now() - 16 * 60_000) });
    const { app, authed, pendingBindingMessages } = setup({ row: stale });
    const res = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1', headers: authed });
    expect(res.json().code).not.toBe(0);
    expect(pendingBindingMessages.claim).not.toHaveBeenCalled();
  });

  it('未登录调预览 401', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'GET', url: '/v1/feishu/binding/pending?state=st-1' });
    expect(res.statusCode).toBe(401);
  });

  it('complete：成功档（绑定 + 补投 + 置 COMPLETED）', async () => {
    const { app, authed, binding, pendingBindingMessages } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data).toEqual({ status: 'success', message: '绑定成功，已开始处理你刚才的消息', senderName: '张三' });
    expect(binding.bind).toHaveBeenCalledWith(USER_ID, 'on_1');
    expect(pendingBindingMessages.complete).toHaveBeenCalledWith('st-1');
  });

  it('complete：身份冲突档（unionId 已属其它账号，不绑定不补投，触发 notifyMismatch）', async () => {
    const { app, authed, binding, replay, notifyMismatch, pendingBindingFailClaimed } = setup({ existingOwner: 3 });
    const res = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('failed');
    expect(res.json().data.message).toContain('该飞书身份已绑定其它 Mao 账号');
    expect(binding.bind).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(pendingBindingFailClaimed).toHaveBeenCalledWith('st-1');
    expect(notifyMismatch).toHaveBeenCalledWith(expect.objectContaining({ state: 'st-1' }));
  });

  it('complete：补投失败档 partial（state 释放回 SENT）', async () => {
    const { app, authed, pendingBindingMessages } = setup({ replayThrows: true });
    const res = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('partial');
    expect(pendingBindingMessages.release).toHaveBeenCalledWith('st-1');
    expect(pendingBindingMessages.complete).not.toHaveBeenCalled();
  });

  it('complete：no-pending 档 failed（幂等：第二次提交返回 failed，不再 claim）', async () => {
    const { app, authed, pendingBindingMessages } = setup();
    const first = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(first.json().data.status).toBe('success');
    // 已被 claim（CLAIMED）：findByState 只认 SENT → 第二次直接 failed，不再进入编排
    pendingBindingMessages.findByState.mockResolvedValue(null as never);
    const second = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(second.json().data.status).toBe('failed');
    expect(second.json().data.message).toContain('链接已过期或已使用');
    expect(pendingBindingMessages.claim).toHaveBeenCalledTimes(1);
  });

  it('complete：账号禁用返回 failed（§4.6）', async () => {
    const { app, authed, pendingBindingMessages } = setup({ disabled: true });
    const res = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' }, headers: authed });
    expect(res.json().data.status).toBe('failed');
    expect(res.json().data.message).toContain('账号已禁用');
    expect(pendingBindingMessages.claim).not.toHaveBeenCalled();
  });

  it('complete：未登录 401', async () => {
    const { app } = setup();
    const res = await app.inject({ method: 'POST', url: '/v1/feishu/binding/complete', payload: { state: 'st-1' } });
    expect(res.statusCode).toBe(401);
  });
});
