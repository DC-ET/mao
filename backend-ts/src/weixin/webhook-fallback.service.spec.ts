import { describe, expect, it, vi } from 'vitest';
import { WeixinWebhookFallbackService } from './webhook-fallback.service.js';
import type { WebhookSenderRegistry } from '../notification/task/webhook-sender.js';

function buildService(overrides: {
  preference?: { channel: string; webhookCiphertext: string } | null;
  decrypt?: (c: string) => string;
  send?: (url: string, message: { text: string; card?: Record<string, unknown> }) => Promise<{ success: boolean; retryable: boolean; httpStatus: number | null; providerCode: string | null; error: string | null }>;
} = {}) {
  const preference = overrides.preference === undefined
    ? { channel: 'DINGTALK', webhookCiphertext: 'cipher-1' }
    : overrides.preference;
  const repo = { findEnabled: vi.fn(async () => preference) };
  const cipher = { decrypt: overrides.decrypt ?? vi.fn(() => 'https://oapi.dingtalk.com/robot/send?access_token=abc') };
  const sent: Array<{ url: string; message: { text: string; card?: Record<string, unknown> } }> = [];
  const send = overrides.send ?? vi.fn(async (url: string, message: { text: string; card?: Record<string, unknown> }) => {
    sent.push({ url, message });
    return { success: true, retryable: false, httpStatus: 200, providerCode: '0', error: null };
  });
  const senderRegistry = {
    get: vi.fn(() => ({ channel: () => 'DINGTALK', send })),
  } as unknown as WebhookSenderRegistry;
  const service = new WeixinWebhookFallbackService(repo as never, cipher as never, senderRegistry);
  return { service, repo, cipher, sent, send };
}

describe('WeixinWebhookFallbackService', () => {
  it('用户已启用通知_把回复原文推送到 webhook', async () => {
    const { service, sent } = buildService();
    expect(await service.sendFallback(42, '微信发送失败的完整回答')).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toContain('oapi.dingtalk.com');
    expect(sent[0].message.text).toContain('微信发送失败的完整回答');
    expect(sent[0].message.text).toContain('发送失败');
  });

  it('飞书渠道_同时下发 text 与 interactive 卡片（勿只发文本退化成普通消息）', async () => {
    const { service, sent } = buildService({ preference: { channel: 'FEISHU', webhookCiphertext: 'c' } });
    expect(await service.sendFallback(42, '微信发送失败的完整回答')).toBe(true);
    const message = sent[0].message;
    expect(message.text).toContain('微信发送失败的完整回答');
    // 卡片是飞书 interactive 分支的开关：缺失时 FeishuWebhookSender 会退化为纯文本消息。
    expect(message.card).toBeDefined();
    const card = JSON.stringify(message.card);
    expect(card).toContain('微信发送失败的完整回答');
    expect(card).toContain('Mao 微信回复发送失败');
    expect(card).toContain('无法送达微信');
  });

  it('userId 为空_跳过且不查询配置', async () => {
    const { service, repo } = buildService();
    expect(await service.sendFallback(null, '回答')).toBe(false);
    expect(repo.findEnabled).not.toHaveBeenCalled();
  });

  it('回复文本为空_直接跳过', async () => {
    const { service, send } = buildService();
    expect(await service.sendFallback(42, '   ')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('用户未启用通知_静默跳过', async () => {
    const { service, send } = buildService({ preference: null });
    expect(await service.sendFallback(42, '回答')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('通知渠道不是钉钉/飞书_跳过', async () => {
    const { service, send } = buildService({ preference: { channel: 'WECHAT', webhookCiphertext: 'c' } });
    expect(await service.sendFallback(42, '回答')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('webhook 解密失败_跳过且不抛出', async () => {
    const { service } = buildService({
      decrypt: () => { throw new Error('bad cipher'); },
    });
    expect(await service.sendFallback(42, '回答')).toBe(false);
  });

  it('webhook 发送失败_返回 false 且不抛出', async () => {
    const { service } = buildService({
      send: async () => ({ success: false, retryable: false, httpStatus: 500, providerCode: null, error: 'boom' }),
    });
    expect(await service.sendFallback(42, '回答')).toBe(false);
  });

  it('webhook 发送抛异常_被捕获并返回 false', async () => {
    const { service } = buildService({
      send: async () => { throw new Error('network down'); },
    });
    expect(await service.sendFallback(42, '回答')).toBe(false);
  });

  it('读取通知配置失败_跳过且不抛出', async () => {
    const repo = { findEnabled: vi.fn(async () => { throw new Error('db down'); }) };
    const cipher = { decrypt: vi.fn(() => 'https://x') };
    const senderRegistry = { get: vi.fn() } as unknown as WebhookSenderRegistry;
    const service = new WeixinWebhookFallbackService(repo as never, cipher as never, senderRegistry);
    expect(await service.sendFallback(42, '回答')).toBe(false);
    expect(senderRegistry.get).not.toHaveBeenCalled();
  });

  it('超长回复截断并提示到桌面端查看完整内容', async () => {
    const { service, sent } = buildService();
    await service.sendFallback(42, 'x'.repeat(9000));
    expect(sent[0].message.text).toContain('内容过长已截断');
    expect(sent[0].message.text.length).toBeLessThan(9000);
  });

  it('超长回复_卡片内同样截断（卡片上限小于文本上限）', async () => {
    const { service, sent } = buildService({ preference: { channel: 'FEISHU', webhookCiphertext: 'c' } });
    await service.sendFallback(42, 'x'.repeat(9000));
    const card = JSON.stringify(sent[0].message.card);
    // 3000 字符预算 + 提示文案 + JSON 结构开销，远小于 9000：确认卡片没有把整段原文塞进去
    expect(card.length).toBeLessThan(9000);
    expect(card).not.toContain('x'.repeat(3001));
    expect(card).toContain('内容过长已截断');
  });
});

describe('WeixinWebhookFallbackService 邮件渠道（V162 决策 4）', () => {
  function buildEmailService(send = vi.fn(async () => ({ success: true, retryable: false, httpStatus: 250, providerCode: null, error: null }))) {
    const preference = { channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' };
    const repo = { findEnabled: vi.fn(async () => preference) };
    const cipher = { decrypt: vi.fn(() => 'user@corp.com') };
    const sent: Array<{ url: string; message: { text: string; card?: Record<string, unknown> } }> = [];
    const wrapped = vi.fn(async (url: string, message: { text: string; card?: Record<string, unknown> }) => {
      sent.push({ url, message });
      return send(url, message);
    });
    const senderRegistry = { get: vi.fn(() => ({ channel: () => 'EMAIL', send: wrapped })) } as unknown as WebhookSenderRegistry;
    const service = new WeixinWebhookFallbackService(repo as never, cipher as never, senderRegistry);
    return { service, sent, send: wrapped };
  }

  it('EMAIL 渠道放行：text 含降级头，card 被忽略不抛错', async () => {
    const { service, sent } = buildEmailService();
    expect(await service.sendFallback(42, '微信发送失败的完整回答')).toBe(true);
    expect(sent).toHaveLength(1);
    // 第一参对邮件渠道即收件邮箱（偏好密文解密值）
    expect(sent[0].url).toBe('user@corp.com');
    expect(sent[0].message.text).toContain('Mao 微信回复发送失败');
    expect(sent[0].message.text).toContain('微信发送失败的完整回答');
    // card 仍然传入（由 email sender 忽略），接口形状不变
    expect(sent[0].message.card).toBeDefined();
  });

  it('EMAIL 渠道发送失败：返回 false 不抛出（不影响微信主流程）', async () => {
    const { service } = buildEmailService(vi.fn(async () => ({ success: false, retryable: false, httpStatus: 535, providerCode: 'EAUTH', error: '535 auth' })));
    expect(await service.sendFallback(42, '回答')).toBe(false);
  });
});
