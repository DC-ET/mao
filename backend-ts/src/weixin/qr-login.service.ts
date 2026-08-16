import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { WeixinAccountRepository } from './account.repository.js';
import type { WeixinMonitorService } from './monitor.service.js';
import type { QrcodeResponse, QrcodeStatusResponse, WeixinBotConfig, WeixinChannelAccount } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';

export class QrLoginService {
  private readonly qrcodeSessionMap = new Map<string, string>();
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
      this.qrcodeSessionMap.set(sessionKey, qrcode);
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
    const qrcode = this.qrcodeSessionMap.get(sessionKey);
    if (qrcode == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '无效的会话Key');
    }
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
      console.debug(`查询扫码状态超时（视为wait）: ${e instanceof Error ? e.message : String(e)}`);
      return { status: 'wait' };
    }
  }

  async saveBindingCredentials(userId: number, botToken: string, baseUrl: string, ilinkUserId: string): Promise<void> {
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
