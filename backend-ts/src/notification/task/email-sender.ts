import { createTransport, type Transporter } from 'nodemailer';
import { hasText } from '../../common/case.js';
import type { EmailSmtpSettings } from '../../settings/types.js';
import type { NotificationChannel, WebhookMessage, WebhookSendResult } from './types.js';
import { webhookFailure, webhookSuccess } from './types.js';
import type { WebhookSender } from './webhook-sender.js';

/** 传输层 socket 超时：对齐 webhook REQUEST_TIMEOUT_MS，慢速对端在此时限内失败并进入重试。 */
const SOCKET_TIMEOUT_MS = 10_000;

/** 配置缺失（未启用 / 缺 host 或发件人）时的统一失败文案：不可重试，避免无谓重试 20 分钟才终态。 */
export const EMAIL_NOT_CONFIGURED_ERROR = '邮件通知未配置或已停用，请联系管理员';

/**
 * SMTP 配置来源：设置服务（发送时实时读，保存后即时生效），
 * 或 test/smtp 端点用表单 overrides 合并出的临时配置。
 */
export interface EmailSmtpConfigProvider {
  getEmailSmtpConfig(): Promise<EmailSmtpSettings>;
}

/**
 * nodemailer SMTP 传输选项（@types/nodemailer 的 SMTPTransport.Options 在 Node16
 * 解析下无法深层导入，这里按 createTransport 实际消费的字段本地声明）。
 */
export interface EmailTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

/** transport 工厂：默认 nodemailer.createTransport，测试注入 stub（方案 §3.1）。 */
export type TransportFactory = (options: EmailTransportOptions) => Transporter;

/**
 * 邮件渠道发送器（V161）：把通知消息渲染为双 Part 邮件（HTML + 纯文本）经 SMTP 发出。
 *
 * 接口第一参对邮件渠道即收件邮箱（delivery.scheduler 解密的 `webhookCiphertext`
 * 在 EMAIL 偏好里存的是收件地址密文）；message.card 与 sessionDetailUrl 被忽略（决策 6）。
 */
export class EmailWebhookSender implements WebhookSender {
  private transport: Transporter | null = null;
  private transportKey: string | null = null;

  constructor(
    private readonly configProvider: EmailSmtpConfigProvider,
    private readonly transportFactory: TransportFactory = createTransport,
  ) {}

  channel(): NotificationChannel {
    return 'EMAIL';
  }

  async send(toEmail: string, message: WebhookMessage): Promise<WebhookSendResult> {
    if (!hasText(toEmail)) {
      return webhookFailure(false, null, null, '收件邮箱不能为空');
    }
    const config = await this.configProvider.getEmailSmtpConfig();
    // from 缺省回落 smtpUser（§3.2）：两者皆空同样按未配置处理
    const from = hasText(config.fromAddr) ? config.fromAddr : config.smtpUser;
    if (!config.enabled || !hasText(config.smtpHost) || !hasText(from)) {
      return webhookFailure(false, null, null, EMAIL_NOT_CONFIGURED_ERROR);
    }
    const { subject, text, html } = renderEmail(message);
    try {
      const info = await this.resolveTransport(config).sendMail({
        from,
        to: toEmail,
        subject,
        text,
        html,
      });
      // 单收件人场景 rejected 正常为空；非空 = 服务端接受了会话但拒收该地址（如 550）
      const rejected = (info.rejected ?? [])
        .map((address: string | { address?: string }) => (typeof address === 'string' ? address : address?.address))
        .filter((address: string | undefined): address is string => hasText(address ?? ''));
      if (rejected.length > 0) {
        return webhookFailure(false, 550, null, `邮件被收件服务器拒绝: ${rejected.join(', ')}`);
      }
      return webhookSuccess(250, null);
    } catch (e) {
      return mapSmtpError(e);
    }
  }

  /** transport 按配置复用：host/port/user/pass/secure 任一变化即重建，不设 TTL。 */
  private resolveTransport(config: EmailSmtpSettings): Transporter {
    const key = [config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPassword, config.useTls].join('|');
    if (this.transport != null && this.transportKey === key) {
      return this.transport;
    }
    // 配置变更（如管理员换了 SMTP 服务器）：释放旧连接池，避免残留 socket 复用旧配置
    this.transport?.close();
    const auth = hasText(config.smtpUser) ? { user: config.smtpUser, pass: config.smtpPassword } : undefined;
    const transport = this.transportFactory({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.useTls,
      auth,
      connectionTimeout: SOCKET_TIMEOUT_MS,
      greetingTimeout: SOCKET_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
    this.transport = transport;
    this.transportKey = key;
    return transport;
  }
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * 邮件渲染（决策 5）：subject 取 text 首行——全部通知文本首行均为固定头
 * （任务通知三类头 / 微信降级头 / 测试通知），不含用户输入，无 CRLF 注入面
 * （后续若把用户标题挪进 subject 需重新评估）。
 *
 * 正文双 Part：text 原文（钉钉 / 飞书回退消费的同款文本）+ HTML（转义后保留
 * 换行与缩进 + 保守内联样式，保 Outlook 兼容）。微信降级推送的 text 已含
 * 「Mao 微信回复发送失败」头与超长截断，原样进 subject / 正文，不特殊处理。
 */
export function renderEmail(message: WebhookMessage): RenderedEmail {
  const text = message.text ?? '';
  const newlineAt = text.indexOf('\n');
  const rawSubject = newlineAt === -1 ? text : text.slice(0, newlineAt);
  // 防御性折叠换行：即使未来 text 首行含用户输入也不构成 header 注入
  const subject = rawSubject.replace(/[\r\n]+/g, ' ').trim();
  const body = newlineAt === -1 ? '' : text.slice(newlineAt + 1);
  return { subject, text, html: buildEmailHtml(subject, body) };
}

function buildEmailHtml(subject: string, body: string): string {
  const escapedBody = escapeHtml(body).replace(/\r?\n/g, '<br />');
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN"><head><meta charset="utf-8" />',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f6f7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Hiragino Sans GB\',\'Microsoft YaHei\',sans-serif;color:#1f2329;font-size:14px;line-height:1.6;">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e6eb;border-radius:8px;overflow:hidden;">',
    `<div style="padding:14px 20px;background:#3370ff;color:#ffffff;font-size:15px;font-weight:600;">${escapeHtml(subject)}</div>`,
    `<div style="padding:20px;">${escapedBody}</div>`,
    '<div style="padding:12px 20px;border-top:1px solid #e5e6eb;color:#86909c;font-size:12px;">本邮件由 Mao 实例自动发送</div>',
    '</div></body></html>',
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 邮箱掩码（§3.3）：本地部分保留首字符 + `***`（本地部分长度 1 时整体 `***`），
 * 如 z***@example.com。偏好 get 的 maskedWebhook 与桌面展示共用。
 */
export function maskEmail(email: string): string {
  const value = (email ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at < 0) {
    return '***';
  }
  const local = value.slice(0, at);
  const domain = value.slice(at);
  if (local.length <= 1) {
    return `***${domain}`;
  }
  return `${local.slice(0, 1)}***${domain}`;
}

/** 网络 / 超时类 nodemailer code：一律可重试。 */
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EAI_AGAIN', 'ESOCKET', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'EDNS',
]);

/**
 * 不可重试的 SMTP 响应码（§2.1-4）：认证失败 535、收件人无效 / 拒收 550/551/553 等永久性失败。
 * 注意不能按「4xx/5xx 数字段」判定——535/550 本身落在 5xx 段，按段映射会把认证失败
 * 误判成可重试，白耗 20 分钟重试才终态。
 */
const PERMANENT_SMTP_CODES = new Set([535, 550, 551, 552, 553, 554, 555, 556]);

/**
 * nodemailer 错误 → WebhookSendResult（§2.1-4 / §7）：
 * 网络错 / 超时 → 可重试；535 / 550 等永久性 SMTP 失败 → 不可重试；
 * 临时性 4xx/5xx 与未覆盖 code 一律按可重试处理（偏保守，重试有上限兜底）。
 */
function mapSmtpError(e: unknown): WebhookSendResult {
  const err = e as { code?: unknown; responseCode?: unknown };
  const code = typeof err?.code === 'string' ? err.code : null;
  const responseCode = typeof err?.responseCode === 'number' ? err.responseCode : null;
  const summary = smtpErrorSummary(e);
  if (code != null && NETWORK_ERROR_CODES.has(code)) {
    return webhookFailure(true, responseCode, code, `邮件发送网络失败: ${summary}`);
  }
  if (responseCode != null && PERMANENT_SMTP_CODES.has(responseCode)) {
    return webhookFailure(false, responseCode, code, `SMTP 错误(${responseCode}): ${summary}`);
  }
  if (responseCode != null) {
    return webhookFailure(true, responseCode, code, `SMTP 服务端错误(${responseCode}): ${summary}`);
  }
  return webhookFailure(true, null, code, `邮件发送失败: ${summary}`);
}

function smtpErrorSummary(e: unknown): string {
  const err = e as { response?: unknown; message?: unknown };
  if (typeof err?.response === 'string' && err.response.trim() !== '') {
    return err.response.trim().slice(0, 200);
  }
  if (typeof err?.message === 'string' && err.message.trim() !== '') {
    return err.message.trim().slice(0, 200);
  }
  return '未知错误';
}
