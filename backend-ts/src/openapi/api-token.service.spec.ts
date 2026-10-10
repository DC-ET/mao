import { describe, expect, it, vi } from 'vitest';
import { ApiTokenService, MAX_TOKENS_PER_USER, sha256Hex } from './api-token.service.js';
import { ApiTokenCipher } from './api-token-cipher.js';
import type { ApiToken, MysqlApiTokenRepository } from './openapi.repository.js';

const CIPHER_KEY = 'spec-token-cipher-key';

function makeRepo() {
  const rows = new Map<number, ApiToken>();
  let nextId = 1;
  const repo = {
    insert: vi.fn(async (token: ApiToken) => {
      const id = nextId++;
      rows.set(id, { ...token, id, revokedAt: null, lastUsedAt: null });
      return id;
    }),
    findByHash: vi.fn(async (hash: string) => [...rows.values()].find((r) => r.tokenHash === hash) ?? null),
    findById: vi.fn(async (id: number) => rows.get(id) ?? null),
    listByUser: vi.fn(async (userId: number) => [...rows.values()].filter((r) => r.userId === userId)),
    countActive: vi.fn(async () => 0),
    revoke: vi.fn(async (id: number, userId: number) => {
      const row = rows.get(id);
      if (row == null || row.userId !== userId || row.revokedAt != null) return false;
      row.revokedAt = '2026-01-01 00:00:00';
      return true;
    }),
    touchLastUsed: vi.fn(async () => undefined),
    rows,
  };
  return repo as unknown as MysqlApiTokenRepository & { rows: Map<number, ApiToken>; touchLastUsed: ReturnType<typeof vi.fn> };
}

describe('ApiTokenService（P1）', () => {
  it('签发：明文返回一次并加密留存，落库存 sha256 + 密文（密文不含明文），前缀 12 位', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo, new ApiTokenCipher(CIPHER_KEY));
    const issued = await service.issue(7, 'CI', ['open:run']);
    expect(issued.plainToken).toMatch(/^mao_[A-Za-z0-9]{48}$/);
    expect(issued.view.tokenPrefix).toBe(issued.plainToken.slice(0, 12));
    expect(issued.view.canCopy).toBe(true);
    const stored = repo.rows.get(issued.id)!;
    expect(stored.tokenHash).toBe(sha256Hex(issued.plainToken));
    expect(stored.tokenCipher).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(issued.plainToken);
  });

  it('未装配 cipher 时不明文留存（canCopy=false，reveal 拒绝）', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    expect(issued.view.canCopy).toBe(false);
    expect(repo.rows.get(issued.id)!.tokenCipher == null).toBe(true);
    await expect(service.reveal(7, issued.id)).rejects.toMatchObject({ code: 2001 });
  });

  it('reveal：属主可随时取回明文；他人与不存在的 Token 拒绝', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo, new ApiTokenCipher(CIPHER_KEY));
    const issued = await service.issue(7, 'CI', ['open:run']);
    await expect(service.reveal(7, issued.id)).resolves.toEqual({ plainToken: issued.plainToken });
    await expect(service.reveal(8, issued.id)).rejects.toMatchObject({ code: 2001 });
    await expect(service.reveal(7, 9999)).rejects.toMatchObject({ code: 2001 });
  });

  it('reveal：旧版签发（无密文）的 Token 无法取回', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo, new ApiTokenCipher(CIPHER_KEY));
    const issued = await service.issue(7, 'CI', ['open:run']);
    repo.rows.get(issued.id)!.tokenCipher = null;
    await expect(service.reveal(7, issued.id)).rejects.toMatchObject({ code: 2001 });
  });

  it('reveal：密文用错密钥解密失败', async () => {
    const repo = makeRepo();
    const issued = await new ApiTokenService(repo, new ApiTokenCipher(CIPHER_KEY)).issue(7, 'CI', ['open:run']);
    const rotated = new ApiTokenService(repo, new ApiTokenCipher('another-key'));
    await expect(rotated.reveal(7, issued.id)).rejects.toMatchObject({ code: 5001 });
  });

  it('list：canCopy 仅有密文的 Token 为 true', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo, new ApiTokenCipher(CIPHER_KEY));
    const legacy = await service.issue(7, 'legacy', ['open:run']);
    repo.rows.get(legacy.id)!.tokenCipher = null;
    await service.issue(7, 'fresh', ['open:run']);
    const views = await service.list(7);
    expect(views.find((v) => v.name === 'legacy')!.canCopy).toBe(false);
    expect(views.find((v) => v.name === 'fresh')!.canCopy).toBe(true);
  });

  it('resolveByToken：明文查哈希命中返回身份，last_used 刷新', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    const identity = await service.resolveByToken(issued.plainToken);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    expect(identity.userId).toBe(7);
    expect(identity.scopes).toEqual(['open:run']);
    expect(identity.tokenId).toBe(issued.id);
    expect(repo.touchLastUsed).toHaveBeenCalledWith(issued.id);
    const missing = await service.resolveByToken('mao_totally_unknown');
    expect(missing).toMatchObject({ ok: false, reason: 'not_found', tokenPrefix: 'mao_totally_' });
  });

  it('吊销后即时失效（resolve 返回 null）；重复吊销报错', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    await service.revoke(7, issued.id);
    await expect(service.resolveByToken(issued.plainToken)).resolves.toMatchObject({ ok: false, reason: 'revoked', tokenId: issued.id, userId: 7 });
    await expect(service.revoke(7, issued.id)).rejects.toMatchObject({ code: 2001 });
  });

  it('过期 token 失效', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    const stored = repo.rows.get(issued.id)!;
    stored.expiresAt = '2000-01-01 00:00:00';
    await expect(service.resolveByToken(issued.plainToken)).resolves.toMatchObject({ ok: false, reason: 'expired', tokenId: issued.id });
  });

  it('scope 清洗：非法 scope 被剔除，签发无有效 scope 拒绝', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    await expect(service.issue(7, 'CI', ['admin:everything'])).rejects.toMatchObject({ code: 2001 });
    const issued = await service.issue(7, 'CI', ['open:run', 'bogus:scope']);
    expect(issued.view.scopes).toEqual(['open:run']);
  });

  it('名称校验 + 每用户上限', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    await expect(service.issue(7, '  ', ['open:run'])).rejects.toMatchObject({ code: 2001 });
    vi.spyOn(repo, 'countActive').mockResolvedValue(MAX_TOKENS_PER_USER);
    await expect(service.issue(7, 'CI', ['open:run'])).rejects.toMatchObject({ code: 2001 });
  });
});
