import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { hasText } from '../../common/case.js';
import { buildTaskNotificationCard } from './feishu-notification-card.js';
import { maskEmail } from './email-sender.js';
import type { PreferenceView, UserTaskNotificationPreference } from './types.js';
import { parseNotificationChannel } from './types.js';
import type { WebhookSecretCipher } from './webhook-secret-cipher.js';
import type { WebhookUrlValidator } from './webhook-url-validator.js';
import type { WebhookSenderRegistry } from './webhook-sender.js';

export interface PreferenceStore {
  findByUserId(userId: number): Promise<UserTaskNotificationPreference | null>;
  insert(row: UserTaskNotificationPreference): Promise<number>;
  updateById(row: UserTaskNotificationPreference): Promise<void>;
}

/** 用户资料邮箱查询（EMAIL 渠道收件地址来源；接 UserRepository.findById 形状）。 */
export interface UserEmailLookup {
  findEmailById(userId: number): Promise<string | null>;
}

/** 邮件渠道开关窄接口：保存 EMAIL 偏好前校验（未启用即拒绝）。 */
export interface EmailSmtpEnabledLookup {
  emailSmtpEnabled(): Promise<boolean>;
}

export class TaskNotificationPreferenceService {
  constructor(
    private readonly store: PreferenceStore,
    private readonly cipher: WebhookSecretCipher,
    private readonly urlValidator: WebhookUrlValidator,
    private readonly senderRegistry: WebhookSenderRegistry,
    /** EMAIL 渠道依赖：缺省时按「未配置邮箱 / 未启用」拒绝，装配层（create-app）注入真实实现。 */
    private readonly emailLookup?: UserEmailLookup,
    private readonly smtpSettings?: EmailSmtpEnabledLookup,
  ) {}

  async get(userId: number): Promise<PreferenceView> {
    const row = await this.store.findByUserId(userId);
    if (!row) {
      return { enabled: false, channel: null, webhookConfigured: false, maskedWebhook: null };
    }
    let masked: string | null = null;
    const configured = hasText(row.webhookCiphertext);
    if (configured) {
      const plain = this.cipher.decrypt(row.webhookCiphertext!);
      // EMAIL 渠道密文存收件邮箱：按邮箱口径掩码（a***@domain.com），不复用 URL 掩码
      masked = row.channel === 'EMAIL' ? maskEmail(plain) : this.urlValidator.mask(plain);
    }
    return {
      enabled: row.enabled === 1,
      channel: row.channel != null ? parseNotificationChannel(row.channel) : null,
      webhookConfigured: configured,
      maskedWebhook: masked,
    };
  }

  async save(userId: number, enabled: boolean, channelValue: string | null | undefined, webhookUrl: string | null | undefined): Promise<PreferenceView> {
    const row = await this.store.findByUserId(userId);
    const channel = hasText(channelValue)
      ? parseNotificationChannel(channelValue)
      : row?.channel != null ? parseNotificationChannel(row.channel) : null;
    const channelChanged = row != null && channel != null && channel !== row.channel;
    let ciphertext = row?.webhookCiphertext ?? null;
    if (channel === 'EMAIL') {
      // EMAIL 分支：仅「本次真正启用（enabled=true）或切换到 EMAIL 渠道」时才要求邮箱存在与
      // SMTP 可用；关闭（enabled=false 且非切渠道）时保留旧密文直接落库。否则资料邮箱被清空的
      // 用户（refreshEmailAddress 已把密文清空但 enabled 仍为 1）会被「请先填写邮箱」拦住，
      // 永远关不掉邮件通知——与下方「enabled=true 时才校验渠道 + 密文齐备」的口径一致。
      // 启用/切渠道时地址只取自用户表 email，每次保存重算密文（不继承旧密文——钩子刷新失败过的
      // 用户保存同渠道偏好仍应拿到当前地址）。
      if (enabled || channelChanged) {
        await this.assertEmailSmtpEnabled();
        const email = await this.lookupEmail(userId);
        if (!hasText(email)) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '请先在个人资料中填写邮箱，再选择邮件通知');
        }
        ciphertext = this.cipher.encrypt(email!);
      }
    } else if (hasText(webhookUrl)) {
      if (channel == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '请选择通知渠道');
      }
      ciphertext = this.cipher.encrypt(this.urlValidator.validate(channel, webhookUrl));
    } else if (channelChanged) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '切换通知渠道时必须填写新的 Webhook 地址');
    }
    if (enabled && (channel == null || !hasText(ciphertext))) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        channel === 'EMAIL' ? '请先在个人资料中填写邮箱' : '开启通知时必须选择渠道并配置 Webhook 地址',
      );
    }
    if (row == null) {
      await this.store.insert({
        userId,
        enabled: enabled ? 1 : 0,
        channel: channel ?? null,
        webhookCiphertext: ciphertext,
      });
    } else {
      row.enabled = enabled ? 1 : 0;
      row.channel = channel ?? row.channel;
      row.webhookCiphertext = ciphertext;
      await this.store.updateById(row);
    }
    return this.get(userId);
  }

  async sendTest(userId: number, channelValue: string, webhookUrl: string | null | undefined): Promise<void> {
    const channel = parseNotificationChannel(channelValue);
    let resolvedUrl: string;
    if (channel === 'EMAIL') {
      // EMAIL 忽略入参 webhookUrl：优先已存 EMAIL 偏好密文，无则回落当前资料邮箱
      // （「发送测试」不必先保存；两者皆无时报邮箱口径错误）。
      resolvedUrl = await this.resolveEmailTarget(userId);
    } else if (hasText(webhookUrl)) {
      resolvedUrl = this.urlValidator.validate(channel, webhookUrl);
    } else {
      const row = await this.store.findByUserId(userId);
      if (row == null || row.channel !== channel || row.webhookCiphertext == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '请先填写或保存当前渠道的 Webhook 地址');
      }
      resolvedUrl = this.cipher.decrypt(row.webhookCiphertext);
    }
    // 测试通知同时发卡片：让用户在后台点「测试」时就能看到真实任务通知的卡片形态（钉钉仍收文本；邮件忽略 card）。
    const result = await this.senderRegistry.get(channel).send(resolvedUrl, {
      text: 'Mao Agent 测试通知\n消息通知配置成功',
      card: buildTaskNotificationCard({ phase: 'COMPLETED', title: '消息通知配置成功' }),
    });
    if (!result.success) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, result.error ?? '测试通知发送失败');
    }
  }

  /**
   * 邮箱变更刷新钩子（决策 2）：用户改邮箱后即时重写 EMAIL 偏好的收件地址，不停发到旧地址。
   * - channel='EMAIL'：新邮箱非空 → 重加密；为空（用户清空邮箱）→ 清空密文
   *   （不动 enabled/channel，findEnabled 因密文为空自然跳过投递）。
   * - 其他渠道 / 无偏好行：no-op。
   * - 失败只 warn 不抛出：资料更新不应被通知链路阻断（与 webhook 地址失效同级的既有容忍度）。
   */
  async refreshEmailAddress(userId: number, email: string | null | undefined): Promise<void> {
    try {
      const row = await this.store.findByUserId(userId);
      if (row == null || row.channel !== 'EMAIL') {
        return;
      }
      const next = hasText(email) ? this.cipher.encrypt(email!.trim()) : null;
      if (next === (row.webhookCiphertext ?? null)) {
        return;
      }
      row.webhookCiphertext = next;
      await this.store.updateById(row);
      if (next == null) {
        console.warn(`用户已清空邮箱，邮件通知收件地址同步清空, userId=${userId}`);
      }
    } catch (e) {
      console.warn(`刷新邮件通知收件地址失败, userId=${userId}`, e);
    }
  }

  async findEnabled(userId: number): Promise<UserTaskNotificationPreference | null> {
    const row = await this.store.findByUserId(userId);
    return row != null && row.enabled === 1 && row.channel != null && row.webhookCiphertext != null ? row : null;
  }

  /** 邮件渠道开关校验：未启用（或缺设置行）时拒绝保存 EMAIL 偏好。 */
  private async assertEmailSmtpEnabled(): Promise<void> {
    const enabled = this.smtpSettings != null ? await this.smtpSettings.emailSmtpEnabled() : false;
    if (!enabled) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '邮件通知未启用，请联系管理员');
    }
  }

  private async lookupEmail(userId: number): Promise<string | null> {
    if (this.emailLookup == null) {
      return null;
    }
    try {
      const email = await this.emailLookup.findEmailById(userId);
      return hasText(email) ? email!.trim() : null;
    } catch (e) {
      console.warn(`读取用户邮箱失败, userId=${userId}`, e);
      return null;
    }
  }

  private async resolveEmailTarget(userId: number): Promise<string> {
    const row = await this.store.findByUserId(userId);
    if (row != null && row.channel === 'EMAIL' && hasText(row.webhookCiphertext)) {
      const stored = this.cipher.decrypt(row.webhookCiphertext!);
      if (hasText(stored)) {
        return stored;
      }
    }
    const email = await this.lookupEmail(userId);
    if (hasText(email)) {
      return email!;
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, '请先保存邮件通知偏好，或在个人资料中填写邮箱');
  }
}
