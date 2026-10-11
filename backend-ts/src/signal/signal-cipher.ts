import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';

/**
 * 哨兵探针请求头 / POST 体的加密（密钥独立配置 APP_SIGNAL_SECRET，与 API Token、
 * 通知 Webhook、MCP 同模式独立轮换）。落库 nonceB64:cipherB64 密文，明文只出现在
 * 探针执行与（打码后的）回显里，不写日志与审计。
 */
export class SignalSecretCipher {
  constructor(private readonly secretKey: string = '') {}

  encrypt(plaintext: string): string {
    this.requireSecretKey();
    return encryptAesGcmNonNull(plaintext, this.secretKey, '哨兵凭据加密失败');
  }

  decrypt(ciphertext: string): string {
    this.requireSecretKey();
    return decryptAesGcm(ciphertext, this.secretKey, '哨兵凭据解密失败');
  }

  private requireSecretKey(): void {
    if (!hasText(this.secretKey)) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '哨兵凭据加密密钥未配置，请设置 APP_SIGNAL_SECRET');
    }
  }
}
