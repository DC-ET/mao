import { describe, expect, it, vi } from 'vitest';
import { MysqlCompanySsoTokenRepository } from './company-sso-token.repository.js';

describe('MysqlCompanySsoTokenRepository', () => {
  it('encrypts on save and the next save overwrites the stored token', async () => {
    const rows = new Map<number, { tokenEnc: string; expiresAt: string }>();
    const db = {
      execute: vi.fn(async (_sql: string, params: unknown[]) => {
        rows.set(Number(params[0]), { tokenEnc: String(params[1]), expiresAt: String(params[2]) });
        return { affectedRows: 1 };
      }),
      queryOne: vi.fn(async (_sql: string, params: unknown[]) => {
        const row = rows.get(Number(params[0]));
        return row ? { userId: Number(params[0]), tokenEnc: row.tokenEnc, expiresAt: row.expiresAt } : null;
      }),
    };
    const repo = new MysqlCompanySsoTokenRepository(db as never, 'synthetic-test-secret-not-a-real-credential');
    await repo.save(7, 'sso-old', new Date('2099-01-01T00:00:00Z'));
    await repo.save(7, 'sso-new', new Date('2099-06-01T00:00:00Z'));
    expect(db.execute).toHaveBeenCalledTimes(2);
    expect(String(db.execute.mock.calls[0][0])).toContain('ON DUPLICATE KEY UPDATE token_enc = VALUES(token_enc)');
    const stored = rows.get(7)!;
    expect(stored.tokenEnc).not.toContain('sso-new');
    expect(stored.expiresAt).toBe('2099-06-01 08:00:00');
    expect(repo.decryptToken((await repo.findByUserId(7))!.tokenEnc)).toBe('sso-new');
  });

  it('returns null when the ciphertext cannot be decrypted', () => {
    const repo = new MysqlCompanySsoTokenRepository({} as never, 'synthetic-test-secret-not-a-real-credential');
    expect(repo.decryptToken('not-a-ciphertext')).toBeNull();
  });
});
