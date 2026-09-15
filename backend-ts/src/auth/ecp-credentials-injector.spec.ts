import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { createEcpCredentialsInjector } from './ecp-credentials-injector.js';

describe('createEcpCredentialsInjector', () => {
  it('writes AccessOne layout and returns token when session is active', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mao-ecp-inject-'));
    const sessions = {
      findByUserId: vi.fn(async () => ({
        sessionTokenEnc: 'enc',
        expiresAt: '2099-01-01 00:00:00',
        renewStatus: 'ACTIVE',
      })),
      decryptToken: vi.fn(() => 'ecp-session-token'),
    };
    const injector = createEcpCredentialsInjector(sessions as never, () => home);
    const token = await injector.injectForUser(7);
    expect(token).toBe('ecp-session-token');
    const account = JSON.parse(await readFile(
      join(home, '.config', 'com.access.accessone', 'profiles', 'mao', 'account.json'),
      'utf8',
    ));
    expect(account.ecp_session_token).toBe('ecp-session-token');
  });

  it('returns null without writing when session is missing or expired', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mao-ecp-inject-'));
    const sessions = {
      findByUserId: vi.fn(async () => null),
      decryptToken: vi.fn(() => 'token'),
    };
    const injector = createEcpCredentialsInjector(sessions as never, () => home);
    expect(await injector.injectForUser(1)).toBeNull();
    expect(sessions.decryptToken).not.toHaveBeenCalled();
  });

  it('clears stale AccessOne layout when session renew failed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mao-ecp-inject-'));
    const accountDir = join(home, '.config', 'com.access.accessone', 'profiles', 'mao');
    const sessions = {
      findByUserId: vi.fn(async () => ({
        sessionTokenEnc: 'enc',
        expiresAt: '2099-01-01 00:00:00',
        renewStatus: 'FAILED',
      })),
      decryptToken: vi.fn(() => 'stale-token'),
    };
    // 先写入一份旧票，模拟历史残留
    await createEcpCredentialsInjector(
      { findByUserId: vi.fn(async () => ({
        sessionTokenEnc: 'enc',
        expiresAt: '2099-01-01 00:00:00',
        renewStatus: 'ACTIVE',
      })), decryptToken: vi.fn(() => 'stale-token') } as never,
      () => home,
    ).injectForUser(1);
    await expect(stat(accountDir)).resolves.toBeTruthy();

    const injector = createEcpCredentialsInjector(sessions as never, () => home);
    expect(await injector.injectForUser(1)).toBeNull();
    expect(sessions.decryptToken).not.toHaveBeenCalled();
    await expect(stat(accountDir)).rejects.toThrow();
  });

  it('clears stale AccessOne layout when session expired', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mao-ecp-inject-'));
    const sessions = {
      findByUserId: vi.fn(async () => ({
        sessionTokenEnc: 'enc',
        expiresAt: '2000-01-01 00:00:00',
        renewStatus: 'ACTIVE',
      })),
      decryptToken: vi.fn(() => 'token'),
    };
    const injector = createEcpCredentialsInjector(sessions as never, () => home);
    expect(await injector.injectForUser(1)).toBeNull();
    expect(sessions.decryptToken).not.toHaveBeenCalled();
  });
});
