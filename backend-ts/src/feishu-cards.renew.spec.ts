import { describe, expect, it, vi } from 'vitest';
import { createRenewAuthLinkHelper } from './feishu-cards.js';

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    state: 's1',
    appId: 3,
    messageId: 'om_in',
    cardMessageId: 'cm_1',
    status: 'SENT',
    event: { senderId: 'ou_1', chatType: 'p2p', messageId: 'om_in' },
    ...overrides,
  };
}

function setup(options: { row?: Record<string, unknown> | null; startThrows?: boolean; passwordEnabled?: boolean; siteBaseUrl?: string | null; feishuEnabled?: boolean } = {}) {
  const pendingBindingMessages = {
    findByCardMessageId: vi.fn(async () => (options.row === undefined ? pendingRow() : options.row)),
    failOthersForCard: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    setCardMessageId: vi.fn(async () => undefined),
  };
  const ecpAuth = {
    // 默认 ECP 开启；密码档 / 飞书 OAuth 档用例下关闭（档位由用例显式指定）
    isEnabled: vi.fn(async () => options.passwordEnabled === undefined && options.feishuEnabled !== true),
    startFeishuLogin: vi.fn(async () => {
      if (options.startThrows === true) throw new Error('ECP 飞书授权启动失败（HTTP 502）');
      return { authUrl: 'https://ecp.example/new', state: 's2' };
    }),
  };
  const feishu = {
    isEnabled: vi.fn(async () => options.feishuEnabled === true),
    getQrCodeUrl: vi.fn(async () => ({ authUrl: 'https://mao.example/qr', state: 'f1' })),
  };
  const renew = createRenewAuthLinkHelper({
    ecpAuth: ecpAuth as never,
    feishu: feishu as never,
    pendingBindingMessages: pendingBindingMessages as never,
    passwordEnabled: async () => options.passwordEnabled === true,
    getSiteBaseUrl: () => options.siteBaseUrl ?? null,
  });
  return { renew, pendingBindingMessages, ecpAuth, feishu };
}

describe('createRenewAuthLinkHelper', () => {
  it('换发新链接并沿用原入站消息', async () => {
    const { renew, pendingBindingMessages, ecpAuth } = setup();
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(true);
    expect(result.authUrl).toBe('https://ecp.example/new');
    expect(result.guide?.title).toBe('新用户绑定');
    expect(ecpAuth.startFeishuLogin).toHaveBeenCalledWith('channel');
    expect(pendingBindingMessages.failOthersForCard).toHaveBeenCalledWith('cm_1', 's2');
    expect(pendingBindingMessages.insert).toHaveBeenCalledWith({
      state: 's2',
      appId: 3,
      messageId: 'om_in',
      event: expect.objectContaining({ senderId: 'ou_1' }),
      cardMessageId: 'cm_1',
    });
    expect(pendingBindingMessages.setCardMessageId).toHaveBeenCalledWith('s2', 'cm_1');
  });

  it('卡片记录不存在时提示重新发消息', async () => {
    const { renew, ecpAuth } = setup({ row: null });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('已失效');
    expect(ecpAuth.startFeishuLogin).not.toHaveBeenCalled();
  });

  it('非原发送者不能换链接', async () => {
    const { renew, pendingBindingMessages } = setup({ row: pendingRow({ event: { senderId: 'ou_2', chatType: 'p2p' } }) });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('仅消息发送者可操作');
    expect(pendingBindingMessages.insert).not.toHaveBeenCalled();
  });

  it('ECP 启动失败时不写入新记录', async () => {
    const { renew, pendingBindingMessages } = setup({ startThrows: true });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('获取新的授权链接失败');
    expect(pendingBindingMessages.failOthersForCard).not.toHaveBeenCalled();
    expect(pendingBindingMessages.insert).not.toHaveBeenCalled();
  });

  it('密码档：ECP / 飞书 OAuth 都关闭时换发指向 SPA 确认页的链接，guide 为密码档文案', async () => {
    const { renew, pendingBindingMessages } = setup({ passwordEnabled: true, siteBaseUrl: 'https://mao.example.com/' });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(true);
    expect(result.authUrl).toMatch(/^https:\/\/mao\.example\.com\/feishu\/bind\/[0-9a-f-]{36}$/);
    expect(result.guide?.buttonLabel).toBe('登录 Mao 并绑定');
    // 新 state 落库并接管卡片；旧链作废
    const inserted = pendingBindingMessages.insert.mock.calls[0][0] as { state: string; cardMessageId: string };
    expect(inserted.cardMessageId).toBe('cm_1');
    expect(pendingBindingMessages.setCardMessageId).toHaveBeenCalledWith(inserted.state, 'cm_1');
    expect(pendingBindingMessages.failOthersForCard).toHaveBeenCalledWith('cm_1', inserted.state);
  });

  it('三档全无时提示未开启任何登录方式', async () => {
    const { renew } = setup({ passwordEnabled: false, siteBaseUrl: 'https://mao.example.com' });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('当前未开启任何登录方式，请联系管理员');
  });

  it('密码档但站点地址缺失时不走密码档', async () => {
    const { renew } = setup({ passwordEnabled: true, siteBaseUrl: null });
    const result = await renew({ botId: 3, cardMessageId: 'cm_1', sender: 'ou_1' });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('当前未开启任何登录方式，请联系管理员');
  });
});
