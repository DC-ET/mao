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

function setup(options: { row?: Record<string, unknown> | null; startThrows?: boolean } = {}) {
  const pendingBindingMessages = {
    findByCardMessageId: vi.fn(async () => (options.row === undefined ? pendingRow() : options.row)),
    failOthersForCard: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    setCardMessageId: vi.fn(async () => undefined),
  };
  const ecpAuth = {
    isEnabled: vi.fn(async () => true),
    startFeishuLogin: vi.fn(async () => {
      if (options.startThrows === true) throw new Error('ECP 飞书授权启动失败（HTTP 502）');
      return { authUrl: 'https://ecp.example/new', state: 's2' };
    }),
  };
  const feishu = {
    isEnabled: vi.fn(async () => false),
    getQrCodeUrl: vi.fn(async () => ({ authUrl: '', state: '' })),
  };
  const renew = createRenewAuthLinkHelper({
    ecpAuth: ecpAuth as never,
    feishu: feishu as never,
    pendingBindingMessages: pendingBindingMessages as never,
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
});
