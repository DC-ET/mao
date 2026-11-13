import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { decryptAesCbc } from '../crypto/aes-cbc.js';
import { SystemGitCredentialService } from './system-git-credential.service.js';

function mockDb(queryResult: unknown[] = [], queryOneResult: unknown = null) {
  return {
    query: vi.fn(async () => queryResult),
    queryOne: vi.fn(async () => queryOneResult),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    insert: vi.fn(async () => 42),
    updateById: vi.fn(async () => ({ affectedRows: 1 })),
  };
}

const SECRET = 'unit-test-secret';

function codeOf(fn: () => Promise<unknown>): Promise<number> {
  return fn().then(
    () => 0,
    (e) => (e instanceof BusinessException ? e.code : -1),
  );
}

describe('SystemGitCredentialService', () => {
  it('create 规范化域名（去协议/路径 + 小写）并加密落库', async () => {
    const db = mockDb();
    const svc = new SystemGitCredentialService(db as never, SECRET);
    const created = await svc.create('https://Git.Acg.Team/path', ' tok-acg ', ' 只读 Token ');
    expect(created.domain).toBe('git.acg.team');
    expect(created.description).toBe('只读 Token');
    const [table, row] = (db.insert as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(table).toBe('system_git_credential');
    expect(row.domain).toBe('git.acg.team');
    expect(row.accessToken).not.toContain('tok-acg');
    expect(typeof row.accessToken).toBe('string');
  });

  it('create 空 Token → PARAM_INVALID；重复域 → GIT_CREDENTIAL_DOMAIN_DUPLICATE', async () => {
    const db = mockDb(null, { id: 1, domain: 'git.acg.team', accessToken: 'x' });
    const svc = new SystemGitCredentialService(db as never, SECRET);
    expect(await codeOf(() => svc.create('git.acg.team', '   '))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(await codeOf(() => svc.create('git.acg.team', 'tok'))).toBe(ErrorCode.GIT_CREDENTIAL_DOMAIN_DUPLICATE.code);
  });

  it('create 非法域名格式 → PARAM_INVALID', async () => {
    const svc = new SystemGitCredentialService(mockDb() as never, SECRET);
    expect(await codeOf(() => svc.create('not a domain', 'tok'))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('update Token 留空不改；备注缺省不改、空串清空', async () => {
    const existing = { id: 9, domain: 'git.acg.team', accessToken: 'old-cipher', description: '旧备注' };
    const db = mockDb([], existing);
    const svc = new SystemGitCredentialService(db as never, SECRET);
    await svc.update(9, '', undefined);
    const [table1, , data1] = (db.updateById as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(table1).toBe('system_git_credential');
    expect(data1.accessToken).toBe('old-cipher');
    expect(data1.description).toBe('旧备注');

    await svc.update(9, 'new-token', '');
    const [, , data2] = (db.updateById as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(data2.accessToken).not.toBe('old-cipher');
    expect(data2.accessToken).not.toContain('new-token');
    expect(data2.description).toBeNull();
  });

  it('update/delete id 不存在 → GIT_CREDENTIAL_NOT_FOUND', async () => {
    const svc = new SystemGitCredentialService(mockDb() as never, SECRET);
    expect(await codeOf(() => svc.update(1, 'tok'))).toBe(ErrorCode.GIT_CREDENTIAL_NOT_FOUND.code);
    expect(await codeOf(() => svc.delete(1))).toBe(ErrorCode.GIT_CREDENTIAL_NOT_FOUND.code);
  });

  it('getTokenMap 加解密往返；解密失败行跳过（不抛出、其余行正常）', async () => {
    const good = { id: 1, domain: 'git.acg.team', accessToken: '' };
    const created = new SystemGitCredentialService(mockDb() as never, SECRET);
    const encrypted = await created.create('git.acg.team', 'tok-acg', null);
    good.accessToken = encrypted.accessToken;
    const rows = [good, { id: 2, domain: 'broken.com', accessToken: 'not-a-valid-ciphertext' }];
    const db = mockDb(rows);
    const svc = new SystemGitCredentialService(db as never, SECRET);
    const map = await svc.getTokenMap();
    expect(map.get('git.acg.team')).toBe('tok-acg');
    expect(map.has('broken.com')).toBe(false);
  });

  it('getTokenMapFiltered 空数组短路不查库；非空按 IN 查询', async () => {
    const db = mockDb([{ id: 1, domain: 'git.acg.team', accessToken: '' }]);
    const svc = new SystemGitCredentialService(db as never, SECRET);
    expect((await svc.getTokenMapFiltered([])).size).toBe(0);
    expect(db.query).not.toHaveBeenCalled();

    await svc.getTokenMapFiltered(['git.acg.team', 'other.com']);
    const [sql, params] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('domain IN (?, ?)');
    expect(params).toEqual(['git.acg.team', 'other.com']);
  });

  it('listDomains 去重排序由 SQL 承担，逐行投影', async () => {
    const db = mockDb([{ domain: 'a.com' }, { domain: 'b.com' }]);
    const svc = new SystemGitCredentialService(db as never, SECRET);
    expect(await svc.listDomains()).toEqual(['a.com', 'b.com']);
    const [sql] = (db.query as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sql).toContain('SELECT domain FROM system_git_credential ORDER BY domain ASC');
  });

  it('加密输出可用同密钥 decryptAesCbc 还原（与用户凭据同口径；错误密钥解密失败）', async () => {
    const svc = new SystemGitCredentialService(mockDb() as never, SECRET);
    const created = await svc.create('git.acg.team', 'tok-roundtrip', null);
    expect(decryptAesCbc(created.accessToken, SECRET)).toBe('tok-roundtrip');
    expect(() => decryptAesCbc(created.accessToken, 'other-secret')).toThrow(BusinessException);
  });
});
