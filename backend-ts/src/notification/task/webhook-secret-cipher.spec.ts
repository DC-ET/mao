import { describe, expect, it } from 'vitest';
import { BusinessException } from '../../common/business-exception.js';
import { WebhookSecretCipher } from './webhook-secret-cipher.js';
import { DEFAULT_NOTIFICATION_SECRET } from './types.js';

describe('WebhookSecretCipher', () => {
  it('usesDefaultSecretWhenEnvironmentOverrideIsMissing', () => {
    const cipher = new WebhookSecretCipher(DEFAULT_NOTIFICATION_SECRET);
    const encrypted = cipher.encrypt('https://example.test');
    expect(cipher.decrypt(encrypted)).toBe('https://example.test');
  });

  it('encryptsWithRandomNonceAndDetectsTampering', () => {
    const cipher = new WebhookSecretCipher('unit-test-secret');
    const plaintext = 'https://open.feishu.cn/open-apis/bot/v2/hook/abc';
    const first = cipher.encrypt(plaintext);
    const second = cipher.encrypt(plaintext);
    expect(first).not.toBe(second);
    expect(cipher.decrypt(first)).toBe(plaintext);
    const tampered = first.slice(0, first.length - 2) + 'AA';
    expect(() => cipher.decrypt(tampered)).toThrow(BusinessException);
  });
});
