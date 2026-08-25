import { randomUUID } from 'node:crypto';
import { createFeishuHttpClient } from './http-client.js';
import { decryptAesGcm } from '../crypto/aes-gcm.js';
import type { FeishuBotRepository, FeishuHttpClient, FeishuNormalizedMessage, FeishuOutboundMessage } from './types.js';

export interface FeishuSendServiceOptions {
  httpClient?: FeishuHttpClient;
  accessToken?: string;
  messageEndpoint: string;
  tokenEndpoint?: string;
}

export interface FeishuReplySender {
  sendText(accountId: string, event: FeishuNormalizedMessage, text: string): Promise<boolean>;
}

export class FeishuSendService {
  private readonly httpClient: FeishuHttpClient;
  constructor(private readonly options: FeishuSendServiceOptions) { this.httpClient = options.httpClient ?? createFeishuHttpClient(); }

  async sendText(receiveId: string, receiveIdType: string, text: string): Promise<boolean> {
    return this.send({ receiveId, receiveIdType, msgType: 'text', content: { text } });
  }

  async send(message: FeishuOutboundMessage): Promise<boolean> {
    const token = this.options.accessToken ?? await this.fetchAccessToken();
    const separator = this.options.messageEndpoint.includes('?') ? '&' : '?';
    const endpoint = `${this.options.messageEndpoint}${separator}receive_id_type=${encodeURIComponent(message.receiveIdType)}`;
    const response = await this.httpClient.request(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ receive_id: message.receiveId, msg_type: message.msgType ?? 'text', content: JSON.stringify(message.content), uuid: randomUUID() }),
    });
    return response.status >= 200 && response.status < 300;
  }

  private async fetchAccessToken(): Promise<string> {
    if (this.options.tokenEndpoint == null) throw new Error('Feishu access token or token endpoint is required');
    const response = await this.httpClient.request(this.options.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (response.status < 200 || response.status >= 300) throw new Error(`Feishu token request failed: HTTP ${response.status}`);
    const body = JSON.parse(response.body.toString('utf8')) as { app_access_token?: string; tenant_access_token?: string };
    const token = body.tenant_access_token ?? body.app_access_token;
    if (token == null || token === '') throw new Error('Feishu token response did not contain an access token');
    return token;
  }
}
