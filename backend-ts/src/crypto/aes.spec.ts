import { createDecipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptAesCbc, encryptAesCbc } from './aes-cbc.js';
import { decryptAesGcm, encryptAesGcm, encryptAesGcmNonNull, encryptAes128Ecb } from './aes-gcm.js';
import { BusinessException } from '../common/business-exception.js';

describe('AES-CBC git credential', () => {
  const secret = 'git-secret-key';

  it('roundtrips', () => {
    const cipher = encryptAesCbc('ghp_token', secret);
    expect(cipher).toContain(':');
    expect(decryptAesCbc(cipher, secret)).toBe('ghp_token');
  });

  it('throws on invalid ciphertext', () => {
    expect(() => decryptAesCbc('nope', secret)).toThrow(BusinessException);
  });
});

describe('AES-GCM webhook/mcp', () => {
  const secret = 'mao-mcp-default-secret-change-me';

  it('roundtrips and uses unique nonces', () => {
    const first = encryptAesGcmNonNull('same-value', secret);
    const second = encryptAesGcmNonNull('same-value', secret);
    expect(first).not.toBe(second);
    expect(decryptAesGcm(first, secret)).toBe('same-value');
    expect(decryptAesGcm(second, secret)).toBe('same-value');
  });

  it('encrypts null as null and empty string as ciphertext', () => {
    expect(encryptAesGcm(null, secret)).toBeNull();
    const empty = encryptAesGcm('', secret);
    expect(empty).toBeTruthy();
    expect(decryptAesGcm(empty!, secret)).toBe('');
  });

  it('decrypts Java-format nonce:cipher+tag using same SHA-256 key', () => {
    const plaintext = 'sk-live-abc';
    const tsCipher = encryptAesGcmNonNull(plaintext, secret);
    const [nonceB64, blobB64] = tsCipher.split(':');
    const nonce = Buffer.from(nonceB64, 'base64');
    const blob = Buffer.from(blobB64, 'base64');
    const tag = blob.subarray(blob.length - 16);
    const encrypted = blob.subarray(0, blob.length - 16);
    const key = createHash('sha256').update(secret, 'utf8').digest();
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    expect(out).toBe(plaintext);
  });
});

describe('AES-128-ECB weixin', () => {
  it('encrypts 16-byte aligned payload', () => {
    const key = Buffer.from('0123456789abcdef');
    const out = encryptAes128Ecb(Buffer.from('hello weixin pad!'), key);
    expect(out.length % 16).toBe(0);
  });
});
