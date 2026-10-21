import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { HttpToolSecretCipher } from './types.js';

/**
 * 自定义 HTTP 工具请求头敏感值加密（密钥独立配置 APP_HTTP_TOOL_SECRET，
 * 与 MCP env / 哨兵凭据同模式独立轮换）。落库 `enc:<密文>`，明文只出现在
 * http_call 执行与（打码后的）回显里，不写日志与审计。
 */
export class HttpToolHeaderCipher implements HttpToolSecretCipher {
  constructor(private readonly secretKey: string = '') {}

  encrypt(plaintext: string): string {
    this.requireSecretKey();
    return encryptAesGcmNonNull(plaintext, this.secretKey, '请求头加密失败');
  }

  decrypt(ciphertext: string): string {
    this.requireSecretKey();
    return decryptAesGcm(ciphertext, this.secretKey, '请求头解密失败');
  }

  private requireSecretKey(): void {
    if (!hasText(this.secretKey)) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '自定义工具请求头加密密钥未配置，请设置 APP_HTTP_TOOL_SECRET');
    }
  }
}
