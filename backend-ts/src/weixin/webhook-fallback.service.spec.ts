import { describe, expect, it, vi } from 'vitest';
import { WeixinWebhookFallbackService } from './webhook-fallback.service.js';
import type { WebhookSenderRegistry } from '../notification/task/webhook-sender.js';

function buildService(overrides: {
  preference?: { channel: string; webhookCiphertext: string } | null;
  decrypt?: (c: string) => string;
  send?: (url: string, message: { text: string }) => Promise<{ success: boolean; retryable: boolean; httpStatus: number | null; providerCode: string | null; error: string | null }>;
} = {}) {
  const preference = overrides.preference === undefined
    ? { channel: 'DINGTALK', webhookCiphertext: 'cipher-1' }
    : overrides.preference;
  const repo = { findEnabled: vi.fn(async () => preference) };
  const cipher = { decrypt: overrides.decrypt ?? vi.fn(() => 'https://oapi.dingtalk.com/robot/send?access_token=abc') };
  const sent: Array<{ url: string; message: { text: string } }> = [];
  const send = overrides.send ?? vi.fn(async (url: string, message: { text: string }) => {
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
});
