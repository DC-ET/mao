import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { hasText } from '../../common/case.js';
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

export class TaskNotificationPreferenceService {
  constructor(
    private readonly store: PreferenceStore,
    private readonly cipher: WebhookSecretCipher,
    private readonly urlValidator: WebhookUrlValidator,
    private readonly senderRegistry: WebhookSenderRegistry,
  ) {}

  async get(userId: number): Promise<PreferenceView> {
    const row = await this.store.findByUserId(userId);
    if (!row) {
      return { enabled: false, channel: null, webhookConfigured: false, maskedWebhook: null };
    }
    let masked: string | null = null;
    const configured = hasText(row.webhookCiphertext);
    if (configured) {
      masked = this.urlValidator.mask(this.cipher.decrypt(row.webhookCiphertext!));
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
    if (hasText(webhookUrl)) {
      if (channel == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '请选择通知渠道');
      }
      ciphertext = this.cipher.encrypt(this.urlValidator.validate(channel, webhookUrl));
    } else if (channelChanged) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '切换通知渠道时必须填写新的 Webhook 地址');
    }
    if (enabled && (channel == null || !hasText(ciphertext))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开启通知时必须选择渠道并配置 Webhook 地址');
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
    if (hasText(webhookUrl)) {
      resolvedUrl = this.urlValidator.validate(channel, webhookUrl);
    } else {
      const row = await this.store.findByUserId(userId);
      if (row == null || row.channel !== channel || row.webhookCiphertext == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '请先填写或保存当前渠道的 Webhook 地址');
      }
      resolvedUrl = this.cipher.decrypt(row.webhookCiphertext);
    }
    const result = await this.senderRegistry.get(channel).send(resolvedUrl, 'Mao Agent 测试通知\n消息通知配置成功');
    if (!result.success) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, result.error ?? '测试通知发送失败');
    }
  }

  async findEnabled(userId: number): Promise<UserTaskNotificationPreference | null> {
    const row = await this.store.findByUserId(userId);
    return row != null && row.enabled === 1 && row.channel != null && row.webhookCiphertext != null ? row : null;
  }
}
