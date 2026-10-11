import { describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { SignalSecretCipher } from './signal-cipher.js';

describe('SignalSecretCipher', () => {
  const cipher = new SignalSecretCipher('unit-test-signcret');

  it('round-trips a plaintext', () => {
    const stored = cipher.encrypt('Bearer token-123');
    expect(stored).not.toContain('Bearer');
    expect(stored).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(cipher.decrypt(stored)).toBe('Bearer token-123');
  });

  it('round-trips an empty string', () => {
    expect(cipher.decrypt(cipher.encrypt(''))).toBe('');
  });

  it('produces a different ciphertext each time (random nonce)', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('round-trips multi-byte content', () => {
    const json = JSON.stringify({ Authorization: ' Bearer 令牌', note: '中文' });
    expect(cipher.decrypt(cipher.encrypt(json))).toBe(json);
  });

  it('rejects encryption without a configured key', () => {
    const empty = new SignalSecretCipher('');
    expect(() => empty.encrypt('x')).toThrow(BusinessException);
    expect(() => empty.encrypt('x')).toThrow(/APP_SIGNAL_SECRET/);
  });

  it('rejects decryption without a configured key', () => {
    const empty = new SignalSecretCipher('');
    expect(() => empty.decrypt('nonce:cipher')).toThrow(BusinessException);
  });

  it('fails to decrypt with a different key', () => {
    const other = new SignalSecretCipher('another-secret');
    const stored = cipher.encrypt('secret-value');
    expect(() => other.decrypt(stored)).toThrow(BusinessException);
  });

  it('fails on a malformed ciphertext', () => {
    expect(() => cipher.decrypt('no-separator')).toThrow(BusinessException);
    expect(() => cipher.decrypt('AAAA:BBBB')).toThrow(BusinessException);
  });

  it('maps failures to INTERNAL_ERROR', () => {
    try {
      new SignalSecretCipher('').encrypt('x');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as BusinessException).code).toBe(ErrorCode.INTERNAL_ERROR.code);
    }
  });
});
