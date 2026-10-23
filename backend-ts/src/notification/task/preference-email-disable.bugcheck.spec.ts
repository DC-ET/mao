import { describe, expect, it, vi } from 'vitest';
import { TaskNotificationPreferenceService } from './preference.service.js';
import type { EmailSmtpEnabledLookup, PreferenceStore, UserEmailLookup } from './preference.service.js';
import type { UserTaskNotificationPreference } from './types.js';
import type { WebhookSecretCipher } from './webhook-secret-cipher.js';
import type { WebhookUrlValidator } from './webhook-url-validator.js';
import type { WebhookSenderRegistry } from './webhook-sender.js';

/**
 * 存在性证明：关闭（enabled=false）邮件通知时仍然强制要求「个人资料里有邮箱」，
 * 导致清空过邮箱的用户永远关不掉邮件通知。
 *
 * 前置状态由系统自身产生：UserService.updateOwnProfile 清空邮箱后回调
 * preference.refreshEmailAddress(userId, null)（create-app.ts:294 注入），
 * 把 EMAIL 偏好的收件密文清空但保留 enabled=1 / channel='EMAIL'
 * （preference.service.spec.ts 已固化该行为：「清空邮箱时清空密文但保留 enabled/channel」）。
 *
 * 之后用户在前端关掉邮件通知 → PUT /v1/user-preferences/task-notification
 * {enabled:false, channel:'EMAIL'} → preference.routes.ts:22 调 save()，
 * 命中 preference.service.ts:66-76 的 EMAIL 分支：
 *   enabled=false、channelChanged=false、但 !hasText(ciphertext) 为真
 *   → 先 assertEmailSmtpEnabled()，再无条件要求 lookupEmail(userId) 非空
 *   → 抛「请先在个人资料中填写邮箱，再选择邮件通知」
 * 于是 enabled 永远停在 1；用户稍后补回邮箱，refreshEmailAddress 又把地址写回去，
 * 邮件通知在用户明确关闭之后重新开始投递。
 *
 * 期望：关闭通知不应依赖收件地址仍然有效（save() 自己在 :85-90 也只在 enabled=true 时
 * 才要求「渠道 + 密文」齐备）。
 */
const cipher = {
  encrypt: (plain: string) => `enc(${plain})`,
  decrypt: (stored: string) => stored.replace(/^enc\(/, '').replace(/\)$/, ''),
} as unknown as WebhookSecretCipher;

const urlValidator = {
  validate: vi.fn((_channel: string, rawUrl: string) => rawUrl),
  mask: vi.fn(() => 'https://example.com/****'),
} as unknown as WebhookUrlValidator;

const registry = {
  get: vi.fn(() => ({ channel: () => 'EMAIL', send: vi.fn(async () => ({ success: true, retryable: false, httpStatus: 200, providerCode: '0', error: null })) })),
} as unknown as WebhookSenderRegistry;

function store(initial: UserTaskNotificationPreference | null = null) {
  let row: UserTaskNotificationPreference | null = initial == null ? null : { ...initial };
  const findByUserId = vi.fn(async () => row);
  const insert = vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r, id: 1 }; return 1; });
  const updateById = vi.fn(async (r: UserTaskNotificationPreference) => { row = { ...r }; });
  return { store: { findByUserId, insert, updateById } as PreferenceStore, findByUserId, insert, updateById };
}

function serviceFor(email: string | null, s: ReturnType<typeof store>, smtpEnabled = true) {
  const lookup = { findEmailById: vi.fn(async () => email) } as UserEmailLookup;
  const settings = { emailSmtpEnabled: vi.fn(async () => smtpEnabled) } as EmailSmtpEnabledLookup;
  const service = new TaskNotificationPreferenceService(s.store, cipher, urlValidator, registry, lookup, settings);
  return { service, lookup, settings };
}

describe('TaskNotificationPreferenceService 关闭邮件通知', () => {
  it('资料邮箱已被清空时，仍应能关闭邮件通知', async () => {
    // 系统自身产生的状态：邮箱清空 → 密文被 refreshEmailAddress 清空，但 enabled 仍为 1
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: null });
    const { service } = serviceFor(null, s);
    await expect(service.save(7, false, 'EMAIL', null)).resolves.toBeDefined();
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));
  });

  it('资料邮箱已被清空时，只提交 enabled=false（不传渠道）也应能关闭', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: null });
    const { service } = serviceFor(null, s);
    await expect(service.save(7, false, null, null)).resolves.toBeDefined();
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));
  });

  it('资料邮箱已被清空时，关闭不应被 SMTP 开关拦住', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: null });
    const { service } = serviceFor(null, s, false);
    await expect(service.save(7, false, 'EMAIL', null)).resolves.toBeDefined();
    expect(s.updateById).toHaveBeenCalledWith(expect.objectContaining({ enabled: 0 }));
  });

  it('对照：邮箱仍在时关闭邮件通知照常成功', async () => {
    const s = store({ id: 1, userId: 7, enabled: 1, channel: 'EMAIL', webhookCiphertext: 'enc(user@corp.com)' });
    const { service } = serviceFor('user@corp.com', s);
    const view = await service.save(7, false, 'EMAIL', null);
    expect(view.enabled).toBe(false);
  });

  it('对照：无邮箱时开启邮件通知仍应被拒绝（既有规则不回退）', async () => {
    const s = store();
    const { service } = serviceFor(null, s);
    await expect(service.save(7, true, 'EMAIL', null)).rejects.toThrow(/请先在个人资料中填写邮箱/);
    expect(s.insert).not.toHaveBeenCalled();
  });
});
