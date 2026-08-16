import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

const NONCE_LENGTH = 12;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * AES/GCM/NoPadding, format `nonceB64:cipherB64` (cipher includes 16-byte tag).
 * Matches WebhookSecretCipher / McpSecretCipher.
 */
export function encryptAesGcm(plaintext: string | null | undefined, secret: string): string | null {
  if (plaintext == null) {
    return null;
  }
  if (plaintext === '') {
    return encryptAesGcmNonNull('', secret);
  }
  return encryptAesGcmNonNull(plaintext, secret);
}

export function encryptAesGcmNonNull(plaintext: string, secret: string, failMessage = '加密失败'): string {
  try {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${nonce.toString('base64')}:${Buffer.concat([encrypted, tag]).toString('base64')}`;
  } catch (e) {
    console.error('AES-GCM encrypt failed', e);
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, failMessage);
  }
}

export function decryptAesGcm(ciphertext: string, secret: string, failMessage = '解密失败'): string {
  try {
    const sep = ciphertext.indexOf(':');
    if (sep <= 0) {
      throw new Error('Invalid ciphertext');
    }
    const nonce = Buffer.from(ciphertext.slice(0, sep), 'base64');
    const blob = Buffer.from(ciphertext.slice(sep + 1), 'base64');
    const tag = blob.subarray(blob.length - 16);
    const encrypted = blob.subarray(0, blob.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('AES-GCM decrypt failed');
    throw new BusinessException(ErrorCode.INTERNAL_ERROR, failMessage);
  }
}

/** AES-128-ECB PKCS5 — Weixin CDN media upload. */
export function encryptAes128Ecb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB PKCS5 — Weixin CDN media download. */
export function decryptAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
