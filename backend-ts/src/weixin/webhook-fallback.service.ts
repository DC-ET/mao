import type { NotificationChannel } from '../notification/task/types.js';
import type { WebhookSenderRegistry } from '../notification/task/webhook-sender.js';
import { buildWeixinFallbackCard, WEIXIN_FALLBACK_HEADER } from '../notification/task/feishu-notification-card.js';

/** webhook 降级推送的正文长度上限：钉钉/飞书文本消息均有长度限制，超长直接截断。 */
const MAX_FALLBACK_TEXT_CHARS = 4000;

/**
 * 飞书单张卡片的 markdown 元素上限：超出后飞书侧渲染异常/拒收。
 * 回复原文按本预算裁剪后再进卡片（与文本出口的 MAX_FALLBACK_TEXT_CHARS 分开计量：
 * 文本上限是给钉钉的，卡片上限是给飞书卡片结构的）。
 */
const MAX_FALLBACK_CARD_CHARS = 3000;

/**
 * 微信下行失败时的 webhook 降级推送。
 *
 * 场景：Agent 已生成回复，但 ilink 拒收（消息体过大 / 24 小时窗口过期 / 网络异常），
 * 用户在微信侧收不到任何内容。此时若用户配置了任务通知 webhook（钉钉/飞书），
 * 把回复原文推过去，用户至少有一个渠道能看到完整内容。
 *
 * 约束：
 * - 只读用户已有的通知配置，不新建配置、不改偏好开关。
 * - webhook 自身失败只 warn，绝不影响微信侧主流程与返回值。
 * - 未启用通知 / 未配置 webhook 时静默跳过（这是正常状态，不是错误）。
 */
export interface WeixinWebhookFallbackRepo {
  findEnabled(userId: number): Promise<{ channel?: string | null; webhookCiphertext?: string | null } | null>;
}

export interface WeixinWebhookFallbackCipher {
  decrypt(ciphertext: string): string;
}

/** 已启用通知偏好的最小形状：渠道 + 加密 webhook 地址。 */
export interface EnabledWebhookPreference {
  channel?: string | null;
  webhookCiphertext?: string | null;
}

export class WeixinWebhookFallbackService {
  constructor(
    private readonly preferenceRepo: WeixinWebhookFallbackRepo,
    private readonly cipher: WeixinWebhookFallbackCipher,
    private readonly senderRegistry: WebhookSenderRegistry,
  ) {}

  /**
   * 把微信发送失败的回复降级推送到用户配置的 webhook。
   * 返回是否实际推送成功（仅用于日志与测试，调用方不应据此改变主流程）。
   */
  async sendFallback(userId: number | null | undefined, replyText: string): Promise<boolean> {
    if (userId == null) {
      console.warn('微信回复 webhook 降级跳过: 账号未关联用户');
      return false;
    }
    const text = (replyText ?? '').trim();
    if (text === '') return false;
    let preference;
    try {
      preference = await this.preferenceRepo.findEnabled(userId);
    } catch (e) {
      console.warn(`微信回复 webhook 降级跳过: 读取通知配置失败, userId=${userId}`, e);
      return false;
    }
    if (preference == null || preference.channel == null || preference.webhookCiphertext == null) {
      console.info(`微信回复 webhook 降级跳过: 用户未启用消息通知, userId=${userId}`);
      return false;
    }
    const channel = preference.channel.trim().toUpperCase();
    // 渠道白名单放行 EMAIL（决策 4）：否则 EMAIL 用户静默收不到降级推送。
    // DINGTALK / FEISHU 行为不变；email sender 忽略 card，只把 text 渲染为邮件。
    if (channel !== 'DINGTALK' && channel !== 'FEISHU' && channel !== 'EMAIL') {
      console.warn(`微信回复 webhook 降级跳过: 不支持的通知渠道 ${channel}, userId=${userId}`);
      return false;
    }
    let webhookUrl: string;
    try {
      webhookUrl = this.cipher.decrypt(preference.webhookCiphertext);
    } catch (e) {
      console.warn(`微信回复 webhook 降级跳过: 解密 webhook 地址失败, userId=${userId}`, e);
      return false;
    }
    const body = text.length > MAX_FALLBACK_TEXT_CHARS
      ? `${text.slice(0, MAX_FALLBACK_TEXT_CHARS)}\n\n（内容过长已截断，完整内容请在 Mao 桌面端/网页端查看）`
      : text;
    // 与正常任务通知同口径：text（钉钉/飞书回退）与 card（飞书 interactive 卡片）都传。
    // 只传 text 时飞书侧退化为纯文本消息，与其它通知的卡片形态不一致。
    const cardBody = text.length > MAX_FALLBACK_CARD_CHARS
      ? `${text.slice(0, MAX_FALLBACK_CARD_CHARS)}\n\n（内容过长已截断，完整内容请在 Mao 桌面端/网页端查看）`
      : text;
    try {
      const result = await this.senderRegistry
        .get(channel as NotificationChannel)
        .send(webhookUrl, {
          text: `${WEIXIN_FALLBACK_HEADER}\n\n${body}`,
          card: buildWeixinFallbackCard({ reply: cardBody }),
        });
      if (result.success) {
        console.info(`微信回复已降级推送至 webhook, userId=${userId}, channel=${channel}`);
        return true;
      }
      console.warn(`微信回复 webhook 降级推送失败, userId=${userId}, channel=${channel}, error=${result.error ?? 'unknown'}`);
      return false;
    } catch (e) {
      console.warn(`微信回复 webhook 降级推送异常, userId=${userId}, channel=${channel}`, e);
      return false;
    }
  }
}
