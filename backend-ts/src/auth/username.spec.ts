import { describe, expect, it } from 'vitest';
import { buildUniqueUsername, fallbackUsername, usernameFromEmail, usernameWithSuffix } from './username.js';

describe('usernameFromEmail', () => {
  it.each([
    ['liqingbo@example.com', 'liqingbo'],
    ['Zheng.Qinzhou@example.com', 'zheng_qinzhou'],
    ['  spaced@example.test  ', 'spaced'],
    ['a-b+c@example.test', 'a_b_c'],
  ])('normalizes %s to %s', (email, expected) => {
    expect(usernameFromEmail(email)).toBe(expected);
  });

  it.each(['', '...@example.test'])('returns null for unusable email %j', (email) => {
    expect(usernameFromEmail(email)).toBeNull();
  });

  it('keeps the normalized full address when the local part is missing', () => {
    expect(usernameFromEmail('@example.test')).toBe('example_test');
  });
});

describe('fallbackUsername', () => {
  it('keeps the provider prefix and sanitizes the seed', () => {
    expect(fallbackUsername('sso', 'fu/1')).toBe('sso_fu_1');
  });
});

describe('usernameWithSuffix', () => {
  it('is stable for the same seed and caps length at 64', () => {
    const base = 'x'.repeat(80);
    const first = usernameWithSuffix(base, 'seed');
    expect(first).toBe(usernameWithSuffix(base, 'seed'));
    expect(first).toHaveLength(64);
    expect(first).toMatch(/_[0-9a-f]{8}$/);
  });

  it('differs per seed', () => {
    expect(usernameWithSuffix('li', 'a')).not.toBe(usernameWithSuffix('li', 'b'));
  });
});

describe('buildUniqueUsername', () => {
  it('prefers the email prefix', async () => {
    expect(await buildUniqueUsername('li@example.test', { prefix: 'sso', seed: 'li@example.test' }, async () => false)).toBe('li');
  });

  it('appends a stable suffix when the prefix is taken', async () => {
    const taken = new Set(['li']);
    const username = await buildUniqueUsername('li@example.test', { prefix: 'sso', seed: 'li@example.test' }, async (name) => taken.has(name));
    expect(username).toMatch(/^li_[0-9a-f]{8}$/);
    expect(await buildUniqueUsername('li@example.test', { prefix: 'sso', seed: 'li@example.test' }, async (name) => taken.has(name))).toBe(username);
  });

  it('falls back to the provider prefix when the email has no usable local part', async () => {
    expect(await buildUniqueUsername('', { prefix: 'ecp', seed: 'user/1' }, async () => false)).toBe('ecp_user_1');
  });

  it('falls back to a random suffix when every deterministic candidate is taken', async () => {
    const username = await buildUniqueUsername('li@example.test', { prefix: 'sso', seed: 'li@example.test' }, async () => true);
    expect(username).toMatch(/^li_[0-9a-f]{8}$/);
    expect(username).not.toBe(usernameWithSuffix('li', 'sso:li@example.test'));
  });
});
