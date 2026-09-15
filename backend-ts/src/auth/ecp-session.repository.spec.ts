import { describe, expect, it, vi } from 'vitest';
import { hasUsableEcpSession, isUsableEcpSession, type UserEcpSession } from './ecp-session.repository.js';

function row(overrides: Partial<UserEcpSession> = {}): UserEcpSession {
  return {
    userId: 1,
    sessionTokenEnc: 'enc',
    expiresAt: '2099-01-01 00:00:00',
    renewStatus: 'ACTIVE',
    ...overrides,
  };
}

describe('isUsableEcpSession', () => {
  it('accepts an active unexpired decryptable session', () => {
    expect(isUsableEcpSession(row(), () => 'token')).toBe(true);
  });

  it('rejects missing, failed, expired or undecryptable sessions', () => {
    expect(isUsableEcpSession(null, () => 'token')).toBe(false);
    expect(isUsableEcpSession(row({ renewStatus: 'FAILED' }), () => 'token')).toBe(false);
    expect(isUsableEcpSession(row({ expiresAt: '2000-01-01 00:00:00' }), () => 'token')).toBe(false);
    expect(isUsableEcpSession(row(), () => null)).toBe(false);
    expect(isUsableEcpSession(row(), () => '')).toBe(false);
  });
});

describe('hasUsableEcpSession', () => {
  it('reads the user row then applies the local usability check', async () => {
    const sessions = {
      findByUserId: vi.fn(async () => row()),
      decryptToken: vi.fn(() => 'token'),
    };
    expect(await hasUsableEcpSession(sessions, 7)).toBe(true);
    expect(sessions.findByUserId).toHaveBeenCalledWith(7);
  });
});
