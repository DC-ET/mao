import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** AES/CBC/PKCS5Padding, format `ivB64:cipherB64` — matches GitCredentialService. */
export function encryptAesCbc(plaintext: string, secret: string): string {
  try {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', deriveKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${encrypted.toString('base64')}`;
  } catch (e) {
    console.error('Failed to encrypt git credential', e);
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, '凭证加密失败');
  }
}

export function decryptAesCbc(ciphertext: string, secret: string): string {
  try {
    const sep = ciphertext.indexOf(':');
    if (sep <= 0) {
      throw new Error('Invalid ciphertext format');
    }
    const iv = Buffer.from(ciphertext.slice(0, sep), 'base64');
    const encrypted = Buffer.from(ciphertext.slice(sep + 1), 'base64');
    const decipher = createDecipheriv('aes-256-cbc', deriveKey(secret), iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('Failed to decrypt git credential', e);
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, '凭证解密失败');
  }
}
