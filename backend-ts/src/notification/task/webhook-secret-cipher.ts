import { decryptAesGcm, encryptAesGcmNonNull } from '../../crypto/aes-gcm.js';
import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { hasText } from '../../common/case.js';
import { DEFAULT_NOTIFICATION_SECRET } from './types.js';

export class WebhookSecretCipher {
  constructor(private readonly secretKey: string = DEFAULT_NOTIFICATION_SECRET) {}

  encrypt(plaintext: string): string {
    this.requireSecretKey();
    return encryptAesGcmNonNull(plaintext, this.secretKey, 'Webhook 加密失败');
  }

  decrypt(ciphertext: string): string {
    this.requireSecretKey();
    return decryptAesGcm(ciphertext, this.secretKey, 'Webhook 解密失败');
  }

  private requireSecretKey(): void {
    if (!hasText(this.secretKey)) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '消息通知加密密钥未配置，请设置 APP_NOTIFICATION_WEBHOOK_SECRET');
    }
  }
}
