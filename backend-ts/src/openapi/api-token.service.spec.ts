import { describe, expect, it, vi } from 'vitest';
import { ApiTokenService, MAX_TOKENS_PER_USER, sha256Hex } from './api-token.service.js';
import type { ApiToken, MysqlApiTokenRepository } from './openapi.repository.js';

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
  it('签发：明文只返回一次，落库只存 sha256，前缀 12 位', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    expect(issued.plainToken).toMatch(/^mao_[A-Za-z0-9]{48}$/);
    expect(issued.view.tokenPrefix).toBe(issued.plainToken.slice(0, 12));
    const stored = repo.rows.get(issued.id)!;
    expect(stored.tokenHash).toBe(sha256Hex(issued.plainToken));
    expect(JSON.stringify(stored)).not.toContain(issued.plainToken);
  });

  it('resolveByToken：明文查哈希命中返回身份，last_used 刷新', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    const identity = await service.resolveByToken(issued.plainToken);
    expect(identity).not.toBeNull();
    expect(identity!.userId).toBe(7);
    expect(identity!.scopes).toEqual(['open:run']);
    expect(identity!.tokenId).toBe(issued.id);
    expect(repo.touchLastUsed).toHaveBeenCalledWith(issued.id);
    expect(await service.resolveByToken('mao_totally_unknown')).toBeNull();
  });

  it('吊销后即时失效（resolve 返回 null）；重复吊销报错', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    await service.revoke(7, issued.id);
    expect(await service.resolveByToken(issued.plainToken)).toBeNull();
    await expect(service.revoke(7, issued.id)).rejects.toMatchObject({ code: 2001 });
  });

  it('过期 token 失效', async () => {
    const repo = makeRepo();
    const service = new ApiTokenService(repo);
    const issued = await service.issue(7, 'CI', ['open:run']);
    const stored = repo.rows.get(issued.id)!;
    stored.expiresAt = '2000-01-01 00:00:00';
    expect(await service.resolveByToken(issued.plainToken)).toBeNull();
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
