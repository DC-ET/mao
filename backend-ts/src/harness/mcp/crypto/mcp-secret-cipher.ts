import { decryptAesGcm, encryptAesGcmNonNull } from '../../../crypto/aes-gcm.js';

export class McpSecretCipher {
  constructor(private readonly secretKey: string) {}

  encrypt(plaintext: string | null | undefined): string | null | undefined {
    if (plaintext == null || plaintext === '') return plaintext;
    return encryptAesGcmNonNull(plaintext, this.secretKey, 'MCP 环境变量加密失败');
  }

  decrypt(ciphertext: string | null | undefined): string | null | undefined {
    if (ciphertext == null || ciphertext === '') return ciphertext;
    return decryptAesGcm(ciphertext, this.secretKey, 'MCP 环境变量解密失败');
  }
}
