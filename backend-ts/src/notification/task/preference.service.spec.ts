import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { TaskNotificationPreferenceService } from './preference.service.js';
import type { PreferenceStore, UserEmailLookup, EmailSmtpEnabledLookup } from './preference.service.js';
import type { UserTaskNotificationPreference } from './types.js';
import type { WebhookSecretCipher } from './webhook-secret-cipher.js';
import type { WebhookUrlValidator } from './webhook-url-validator.js';
import type { WebhookSenderRegistry } from './webhook-sender.js';

const DINGTALK_URL = 'https://oapi.dingtalk.com/robot/send?access_token=abc';
const DINGTALK_MASK = 'https://oapi.dingtalk.com/robot/send?access_token=****abc';

/** 测试用可逆 cipher：'enc(<plain>)' 即密文，避免依赖真实密钥环境。 */
const cipher = {
  encrypt: (plain: string) => `enc(${plain})`,
  decrypt: (stored: string) => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
} as unknown as WebhookSecretCipher;

const urlValidator = {
  validate: vi.fn((_channel: string, rawUrl: string) => rawUrl),
  mask: vi.fn(() => DINGTALK_MASK),
} as unknown as WebhookUrlValidator;

function senderRegistry(send = vi.fn(async () => ({ success: true, retryable: false, httpStatus: 200, providerCode: '0', error: null }))) {
  return { registry: { get: vi.fn(() => ({ channel: () => 'EMAIL', send })) } as unknown as WebhookSenderRegistry, send };
}

function store(initial: UserTaskNotificationPreference | null = null) {
  let row: UserTaskNotificationPreference | null = initial == null ? null : { ...initial };
  const findByUserId = vi.fn(async () => row);
  const insert = vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r, id: 1 }; return 1; });
  const updateById = vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r }; });
  return { store: { findByUserId, insert, updateById } as PreferenceStore, findByUserId, insert, updateById };
}

function emailLookup(email: string | null, findEmailById = vi.fn(async () => email)) {
  return { lookup: { findEmailById } as UserEmailLookup, findEmailById };
}

function smtp(enabled = true) {
  return { settings: { emailSmtpEnabled: vi.fn(async () => enabled) } as EmailSmtpEnabledLookup };
}

describe('TaskNotificationPreferenceService webhook 渠道（既有行为回归）', () => {
  it('保存钉钉渠道并回掩码', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    const view = await service.save(7, true, 'DINGTALK', DINGTALK_URL);
    expect(view.channel).toBe('DINGTALK');
    expect(view.webhookConfigured).toBe(true);
    expect(view.maskedWebhook).toBe(DINGTALK_MASK);
    expect(s.insert).toHaveBeenCalledWith({ userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: `enc(${DINGTALK_URL})` });
  });

  it('切换渠道不填新地址被拒绝（既有规则不回退）', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: `enc(${DINGTALK_URL})` });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await expect(service.save(7, true, 'FEISHU', null)).rejects.toThrow(BusinessException);
    await expect(service.save(7, true, 'FEISHU', null)).rejects.toThrow(/必须填写新的 Webhook 地址/);
  });

  it('开启通知但无渠道无密文被拒绝', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await expect(service.save(7, true, null, null)).rejects.toThrow(/必须选择渠道并配置 Webhook 地址/);
  });

  it('sendTest 用入参地址发送，失败透出错误', async () => {
    const s = store();
    const { registry, send } = senderRegistry(vi.fn(async () => ({ success: false, retryable: false, httpStatus: 400, providerCode: null, error: 'bad token' })));
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await expect(service.sendTest(7, 'DINGTALK', DINGTALK_URL)).rejects.toThrow(/bad token/);
    expect(send).toHaveBeenCalledWith(DINGTALK_URL, expect.objectContaining({ text: expect.stringContaining('Mao Agent 测试通知') }));
  });

  it('sendTest 无入参地址时回落已存密文', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: `enc(${DINGTALK_URL})` });
    const { registry, send } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.sendTest(7, 'DINGTALK', null);
    expect(send).toHaveBeenCalledWith(DINGTALK_URL, expect.anything());
  });
});

describe('TaskNotificationPreferenceService EMAIL 渠道', () => {
  it('保存 EMAIL：地址取自用户表，密文每次重算', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: `enc(${DINGTALK_URL})` });
    const { registry } = senderRegistry();
    const { lookup } = emailLookup('user@corp.com');
    const { settings } = smtp();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, settings);
    const view = await service.save(7, true, 'EMAIL', null);
    expect(view.channel).toBe('EMAIL');
    expect(view.maskedWebhook).toBe('u***@corp.com');
    // 不继承旧 webhook 密文，重算为当前邮箱
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)',
    }));
  });

  it('钩子刷新失败留旧密文后再次保存 EMAIL：仍重算为当前邮箱', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(old@corp.com)' });
    const { registry } = senderRegistry();
    const { lookup } = emailLookup('new@corp.com');
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await service.save(7, true, 'EMAIL', null);
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({ webhookCiphertext: 'enc(new@corp.com)' }));
  });

  it('用户无邮箱时保存 EMAIL 被拒绝', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const { lookup } = emailLookup(null);
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await expect(service.save(7, true, 'EMAIL', null)).rejects.toThrow(/请先在个人资料中填写邮箱/);
    expect(s.insert).not.toHaveBeenCalled();
  });

  it('SMTP 开关关闭时选 EMAIL 被拒绝', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const { lookup } = emailLookup('user@corp.com');
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp(false).settings);
    await expect(service.save(7, true, 'EMAIL', null)).rejects.toThrow(/邮件通知未启用/);
  });

  it('EMAIL→钉钉仍要求填 webhook（既有规则不回退）', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' });
    const { registry } = senderRegistry();
    const { lookup } = emailLookup('user@corp.com');
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await expect(service.save(7, true, 'DINGTALK', null)).rejects.toThrow(/必须填写新的 Webhook 地址/);
  });

  it('get 对 EMAIL 返回邮箱掩码而非 URL 掩码', async () => {
    vi.mocked(urlValidator.mask).mockClear();
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    const view = await service.get(7);
    expect(view.maskedWebhook).toBe('u***@corp.com');
    expect(urlValidator.mask).not.toHaveBeenCalled();
  });

  it('sendTest EMAIL：忽略入参 webhookUrl，用已存密文地址', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' });
    const { registry, send } = senderRegistry();
    const { lookup } = emailLookup('other@corp.com');
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await service.sendTest(7, 'EMAIL', 'https://evil.example.com/hook');
    expect(send).toHaveBeenCalledWith('user@corp.com', expect.objectContaining({ text: expect.stringContaining('Mao Agent 测试通知') }));
  });

  it('sendTest EMAIL：无已存偏好时回落当前资料邮箱（不必先保存）', async () => {
    const s = store();
    const { registry, send } = senderRegistry();
    const { lookup } = emailLookup('user@corp.com');
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await service.sendTest(7, 'EMAIL', null);
    expect(send).toHaveBeenCalledWith('user@corp.com', expect.anything());
  });

  it('sendTest EMAIL：无偏好且无资料邮箱时报邮箱口径错误', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const { lookup } = emailLookup(null);
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, smtp().settings);
    await expect(service.sendTest(7, 'EMAIL', null)).rejects.toThrow(/请先保存邮件通知偏好/);
  });

  it('findEnabled：EMAIL 密文被清空后不再投递', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: null });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    expect(await service.findEnabled(7)).toBeNull();
  });
});

describe('TaskNotificationPreferenceService.refreshEmailAddress', () => {
  it('EMAIL 渠道：用新邮箱重写密文', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(old@corp.com)' });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.refreshEmailAddress(7, 'new@corp.com');
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({ webhookCiphertext: 'enc(new@corp.com)' }));
  });

  it('EMAIL 渠道：清空邮箱时清空密文但保留 enabled/channel', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(old@corp.com)' });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.refreshEmailAddress(7, null);
    expect(s.updateById).toHaveBeenCalledWith({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: null });
  });

  it('其他渠道：no-op 不改密文', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'DINGTALK', webhookCiphertext: `enc(${DINGTALK_URL})` });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.refreshEmailAddress(7, 'new@corp.com');
    expect(s.updateById).not.toHaveBeenCalled();
  });

  it('无偏好行：no-op', async () => {
    const s = store();
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.refreshEmailAddress(7, 'new@corp.com');
    expect(s.updateById).not.toHaveBeenCalled();
  });

  it('刷新失败只 warn 不抛出（资料更新不被阻断）', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(old@corp.com)' });
    s.updateById = vi.fn(async () => { throw new Error('db down'); }) as never;
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await expect(service.refreshEmailAddress(7, 'new@corp.com')).resolves.toBeUndefined();
  });

  it('邮箱未变化（密文相同）时不写库', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' });
    const { registry } = senderRegistry();
    const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry);
    await service.refreshEmailAddress(7, 'user@corp.com');
    expect(s.updateById).not.toHaveBeenCalled();
  });
});
