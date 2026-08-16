import type { NotificationChannel, WebhookSendResult } from './types.js';
import { webhookFailure, webhookSuccess } from './types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface WebhookSender {
  channel(): NotificationChannel;
  send(webhookUrl: string, content: string): Promise<WebhookSendResult>;
}

export class DingTalkWebhookSender implements WebhookSender {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  channel(): NotificationChannel {
    return 'DINGTALK';
  }

  async send(webhookUrl: string, content: string): Promise<WebhookSendResult> {
    try {
      const json = JSON.stringify({ msgtype: 'text', text: { content } });
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: json,
      });
      const body = await response.text();
      const root = body.trim() === '' ? {} : JSON.parse(body) as Record<string, unknown>;
      const code = root.errcode != null ? String(root.errcode) : null;
      if (response.ok && code === '0') {
        return webhookSuccess(response.status, code);
      }
      const retryable = response.status === 429 || response.status >= 500;
      const message = typeof root.errmsg === 'string' ? root.errmsg : '钉钉 Webhook 请求失败';
      return webhookFailure(retryable, response.status, code, message);
    } catch {
      return webhookFailure(true, null, null, '钉钉 Webhook 网络请求失败');
    }
  }
}

export class FeishuWebhookSender implements WebhookSender {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  channel(): NotificationChannel {
    return 'FEISHU';
  }

  async send(webhookUrl: string, content: string): Promise<WebhookSendResult> {
    try {
      const json = JSON.stringify({ msg_type: 'text', content: { text: content } });
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: json,
      });
      const body = await response.text();
      const root = body.trim() === '' ? {} : JSON.parse(body) as Record<string, unknown>;
      const codeNode = root.code ?? root.StatusCode;
      const code = codeNode != null ? String(codeNode) : null;
      if (response.ok && code === '0') {
        return webhookSuccess(response.status, code);
      }
      const retryable = response.status === 429 || response.status >= 500;
      const message = typeof root.msg === 'string' ? root.msg
        : typeof root.StatusMessage === 'string' ? root.StatusMessage
          : '飞书 Webhook 请求失败';
      return webhookFailure(retryable, response.status, code, message);
    } catch {
      return webhookFailure(true, null, null, '飞书 Webhook 网络请求失败');
    }
  }
}

export class WebhookSenderRegistry {
  private readonly senders = new Map<NotificationChannel, WebhookSender>();

  constructor(senders: WebhookSender[]) {
    for (const sender of senders) {
      this.senders.set(sender.channel(), sender);
    }
  }

  get(channel: NotificationChannel): WebhookSender {
    const sender = this.senders.get(channel);
    if (!sender) {
      throw new Error(`Missing webhook sender for ${channel}`);
    }
    return sender;
  }
}
