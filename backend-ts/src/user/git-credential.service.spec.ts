import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { decryptAesCbc, encryptAesCbc } from '../crypto/aes-cbc.js';
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

  it('getTokenMapByUserFiltered 只查询/解密交集域，空数组直接短路', async () => {
    vi.mocked(db.query).mockClear();

    // 空数组：方法作为 API 的边界保护，不查库（防 IN () 非法 SQL）
    expect(await service.getTokenMapByUserFiltered(1, [])).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();

    // 非空：WHERE user_id = ? AND domain IN (?, ...)，只返回密文可解的交集
    vi.mocked(db.query).mockResolvedValueOnce([
      { id: 1, userId: 1, domain: 'git.acg.team', accessToken: encryptAesCbc('tok-acg', secret) },
    ] as never);
    const result = await service.getTokenMapByUserFiltered(1, ['git.acg.team', 'github.com']);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('domain IN (?, ?)'),
      [1, 'git.acg.team', 'github.com'],
    );
    expect(result.get('git.acg.team')).toBe('tok-acg');
    expect(result.size).toBe(1);

    // userId 为空：同样直接短路
    vi.mocked(db.query).mockClear();
    expect(await service.getTokenMapByUserFiltered(null, ['github.com'])).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });
});
