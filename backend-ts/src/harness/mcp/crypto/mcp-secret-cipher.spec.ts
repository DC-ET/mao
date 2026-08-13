import { describe, expect, it } from 'vitest';
import { BusinessException } from '../../../common/business-exception.js';
import { McpSecretCipher } from './mcp-secret-cipher.js';

describe('McpSecretCipher', () => {
  const cipher = new McpSecretCipher('unit-test-secret');

  it('encryptThenDecryptRoundTrips', () => {
    const plaintext = '{"API_KEY":"sk-test-123","REGION":"cn-north-1"}';
    const encrypted = cipher.encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(cipher.decrypt(encrypted)).toBe(plaintext);
  });

  it('encryptsWithRandomNonceSoCiphertextsDiffer', () => {
    const first = cipher.encrypt('same-value');
    const second = cipher.encrypt('same-value');
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe('same-value');
    expect(cipher.decrypt(second)).toBe('same-value');
  });

  it('detectsTamperedCiphertext', () => {
    const encrypted = cipher.encrypt('sk-live-abc')!;
    const tampered = encrypted.slice(0, encrypted.length - 4) + 'AAAA';
    expect(() => cipher.decrypt(tampered)).toThrow(BusinessException);
  });

  it('decryptThrowsOnMalformedFormat', () => {
    expect(() => cipher.decrypt('no-colon-separator')).toThrow(BusinessException);
    expect(() => cipher.decrypt(':')).toThrow(BusinessException);
    expect(() => cipher.decrypt('not-base64:also-not-base64')).toThrow(BusinessException);
  });

  it('nullAndEmptyValuesPassThroughUntouched', () => {
    expect(cipher.encrypt(null)).toBeNull();
    expect(cipher.decrypt(null)).toBeNull();
    expect(cipher.encrypt('')).toBe('');
    expect(cipher.decrypt('')).toBe('');
  });
});
