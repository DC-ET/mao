import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { WeixinMonitorService } from './monitor.service.js';
import type { QrcodeResponse, QrcodeStatusResponse, WeixinBotConfig, WeixinChannelAccount } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

const QR_CODE_TTL_MS = 5 * 60 * 1000; // 扫码会话有效期：5 分钟

export class QrLoginService {
  private readonly qrcodeSessionMap = new Map<string, { qrcode: string; expiresAt: number }>();
  private readonly qrHttp: WeixinHttpClient;
  private readonly statusHttp: WeixinHttpClient;

  constructor(
    private readonly config: WeixinBotConfig,
    private readonly accountRepository: WeixinAccountRepository,
    private readonly monitorService: WeixinMonitorService,
    http?: { qr?: WeixinHttpClient; status?: WeixinHttpClient },
  ) {
    this.qrHttp = http?.qr ?? createWeixinHttpClient(35_000);
    this.statusHttp = http?.status ?? createWeixinHttpClient(10_000);
  }

  async getQrcode(_userId: number): Promise<QrcodeResponse> {
    if (!this.config.enabled) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '微信Bot功能未启用');
    }
    try {
      const url = `${this.config.ilinkBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
      const response = await this.qrHttp.request(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 35_000,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, `获取二维码失败: HTTP ${response.status}`);
      }
      const jsonNode = JSON.parse(response.body.toString('utf8')) as {
        qrcode?: string;
        qrcode_img_content?: string;
      };
      const qrcode = jsonNode.qrcode ?? '';
      const qrImgContent = jsonNode.qrcode_img_content ?? '';
      let qrDataUrl: string;
      if (qrImgContent.startsWith('http://') || qrImgContent.startsWith('https://')) {
        qrDataUrl = qrImgContent;
      } else if (qrImgContent.startsWith('data:')) {
        qrDataUrl = qrImgContent;
      } else if (qrImgContent.length > 0) {
        qrDataUrl = `data:image/png;base64,${qrImgContent}`;
      } else {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, '获取二维码失败: 图片内容为空');
      }
      const sessionKey = randomUUID();
      this.qrcodeSessionMap.set(sessionKey, { qrcode, expiresAt: Date.now() + QR_CODE_TTL_MS });
      return {
        sessionKey,
        qrDataUrl,
        message: '使用微信扫描以下二维码，以完成连接。',
      };
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error('获取微信二维码失败', e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, `获取二维码失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async getQrcodeStatus(sessionKey: string): Promise<QrcodeStatusResponse> {
    const entry = this.qrcodeSessionMap.get(sessionKey);
    // L-5：惰性淘汰——过期/已确认的 sessionKey 直接删除，避免 Map 无限增长（放弃扫码/刷新均泄漏）
    if (entry == null || entry.expiresAt < Date.now()) {
      if (entry != null) this.qrcodeSessionMap.delete(sessionKey);
      throw new BusinessException(ErrorCode.PARAM_INVALID, '无效的会话Key');
    }
    const qrcode = entry.qrcode;
    try {
      const url = `${this.config.ilinkBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      const response = await this.statusHttp.request(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 10_000,
      });
      if (response.status < 200 || response.status >= 300) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, `查询扫码状态失败: HTTP ${response.status}`);
      }
      const jsonNode = JSON.parse(response.body.toString('utf8')) as {
        status?: string;
        bot_token?: string;
        baseurl?: string;
        ilink_user_id?: string;
      };
      const status = jsonNode.status ?? '';
      const result: QrcodeStatusResponse = { status };
      if (status === 'confirmed') {
        result.botToken = jsonNode.bot_token;
        result.baseUrl = jsonNode.baseurl;
        result.ilinkUserId = jsonNode.ilink_user_id;
      }
      return result;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      // 网络错误（非超时）上抛，避免前端把持续 5xx 误判为 wait 无限轮询；
      // 仅超时场景返回 wait 让前端继续等待用户扫码。
      if (isTimeoutError(e)) {
        console.debug(`查询扫码状态超时（视为wait）: ${e instanceof Error ? e.message : String(e)}`);
        return { status: 'wait' };
      }
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, `查询扫码状态失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async saveBindingCredentials(userId: number, botToken: string, baseUrl: string, ilinkUserId: string): Promise<void> {
    if (!this.config.enabled) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '微信Bot功能未启用');
    }
    // L-4：baseUrl 会被 monitorLoop 周期性携带 Authorization 请求，必须校验协议与目标，
    // 禁止 http/私网/环回/链路本地（盲 SSRF 面），与 WebhookUrlValidator 口径一致。
    validateCallbackBaseUrl(baseUrl);
    if (botToken == null || botToken.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'bot_token 不能为空');
    }
    const accountId = `user_${userId}`;
    const payload = {
      token: botToken,
      baseUrl,
      userId: ilinkUserId,
      savedAt: new Date().toISOString().replace(/\.\d{3}Z$/, '').replace('Z', ''),
    };
    try {
      const payloadJson = JSON.stringify(payload);
      const existingAccount = await this.accountRepository.findByUserId(userId);
      if (existingAccount != null) {
        existingAccount.payloadJson = payloadJson;
        existingAccount.getUpdatesBuf = null;
        existingAccount.enabled = 1;
        await this.accountRepository.update(existingAccount);
      } else {
        const account: WeixinChannelAccount = {
          userId,
          accountId,
          payloadJson,
          enabled: 1,
        };
        await this.accountRepository.create(account);
      }
      console.info(`保存微信Bot绑定凭据成功, userId=${userId}`);
      this.monitorService.startMonitor(accountId);
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error('保存微信Bot绑定凭据失败', e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '保存绑定凭据失败');
    }
  }

  clearQrcodeSession(sessionKey: string): void {
    this.qrcodeSessionMap.delete(sessionKey);
  }
}

/** 校验微信回调 baseUrl：仅允许 https + 公网域名，拒绝私网/环回/链路本地（盲 SSRF 防护）。 */
export function validateCallbackBaseUrl(baseUrl: string): void {
  if (baseUrl == null || baseUrl.trim() === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'baseUrl 不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'baseUrl 不是合法 URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'baseUrl 必须使用 https');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedHostname(hostname)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'baseUrl 不允许指向私网/环回/链路本地地址');
  }
}

function isPrivateOrReservedHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // IPv4 / IPv6 字面量
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  if (v4) {
    const parts = hostname.split('.').map(Number);
    const [a, b] = parts;
    const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true; // 私网
    if (a === 127) return true; // 环回
    if (a === 169 && b === 254) return true; // 链路本地
    if (ip >= 0x0A000000 && ip <= 0x0AFFFFFF) return true;
    if (ip <= 0x00FFFFFF || ip >= 0xFFFFFFFF - 0xFF) return true; // 0.x 与 255.x
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (hostname.includes(':')) return true; // IPv6：保守拒绝字面量
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

function isTimeoutError(e: unknown): boolean {
  const err = e as { code?: string; name?: string } | null;
  return err != null && (err.code === 'ETIMEDOUT' || err.code === 'ESOCKETTIMEDOUT' || err.name === 'TimeoutError');
}
