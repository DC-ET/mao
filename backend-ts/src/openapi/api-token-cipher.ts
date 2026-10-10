import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';

/**
 * API Token 明文加密 / 解密（密钥与通知 Webhook、MCP 环境变量同模式，独立配置独立轮换）。
 * 落库的是 nonceB64:cipherB64 密文，明文不出现在响应与日志之外的持久层；
 * 鉴权仍走 token_hash，本密文只服务于「创建后再次复制」。
 */
export class ApiTokenCipher {
  constructor(private readonly secretKey: string = '') {}

  encrypt(plaintext: string): string {
    this.requireSecretKey();
    return encryptAesGcmNonNull(plaintext, this.secretKey, 'Token 加密失败');
  }

  decrypt(ciphertext: string): string {
    this.requireSecretKey();
    return decryptAesGcm(ciphertext, this.secretKey, 'Token 解密失败');
  }

  private requireSecretKey(): void {
    if (!hasText(this.secretKey)) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'Token 加密密钥未配置，请设置 APP_OPENAPI_TOKEN_SECRET');
    }
  }
}
