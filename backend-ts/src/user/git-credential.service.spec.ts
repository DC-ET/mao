import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { decryptAesCbc } from '../crypto/aes-cbc.js';
import type { Db } from '../db/db.js';
import { GitCredentialService } from './git-credential.service.js';

describe('GitCredentialService', () => {
  const secret = 'git-secret-key-for-tests';
  const db = {
    query: vi.fn(),
    queryOne: vi.fn(),
    insert: vi.fn(async () => 9),
    updateById: vi.fn(),
    execute: vi.fn(),
  } as unknown as Db;
  const service = new GitCredentialService(db, secret);

  it('create encrypts token and rejects duplicate domain', async () => {
    vi.mocked(db.queryOne).mockResolvedValueOnce(null);
    const created = await service.create(1, 'https://GitHub.com/foo', 'ghp_token_value', 'desc');
    expect(created.domain).toBe('github.com');
    expect(decryptAesCbc(created.accessToken, secret)).toBe('ghp_token_value');
    vi.mocked(db.queryOne).mockResolvedValueOnce({ id: 1, userId: 1, domain: 'github.com', accessToken: 'x' });
    await expect(service.create(1, 'github.com', 'tok', null)).rejects.toBeInstanceOf(BusinessException);
  });

  it('envVarNameForDomain', () => {
    expect(GitCredentialService.envVarNameForDomain('git.example.com')).toBe('GIT_TOKEN_git_example_com');
  });

  it('assertGitCredentialSecret rejects blank keys', async () => {
    const { assertGitCredentialSecret } = await import('./git-credential.service.js');
    expect(() => assertGitCredentialSecret('')).toThrow(/APP_GIT_CREDENTIAL_SECRET/);
    expect(() => assertGitCredentialSecret('   ')).toThrow(/APP_GIT_CREDENTIAL_SECRET/);
    expect(() => assertGitCredentialSecret(undefined)).toThrow(/APP_GIT_CREDENTIAL_SECRET/);
    expect(() => assertGitCredentialSecret('ok-secret')).not.toThrow();
  });

  it('maskToken', () => {
    expect(service.maskToken('')).toBe('****');
    expect(service.maskToken('short')).toBe('****');
    expect(service.maskToken('abcdefghijkl')).toBe('abcd****ijkl');
  });
});
