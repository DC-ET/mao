import { describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { encryptAesCbc } from '../crypto/aes-cbc.js';
import { EnvVariableService, maskEnvValueForAdmin } from './env-variable.service.js';
import type { EnvVariable, EnvVariablePatch, EnvVariableRepository } from './types.js';

const SECRET = 'unit-test-secret';
const ROOT = '/tmp/mao-env-test-workspace';

interface Row extends EnvVariable { id: number }

/** 内存仓储：三张表分开，唯一键冲突按 DB 语义抛 ER_DUP_ENTRY。 */
class FakeRepo implements EnvVariableRepository {
  system: Row[] = [];
  users: Row[] = [];
  workspaces: Row[] = [];
  listCalls = 0;
  private seq = 1;

  private nextId(): number { return this.seq++; }

  private checkUnique(rows: Row[], matcher: (row: Row) => boolean): void {
    if (rows.some(matcher)) {
      const error = new Error('Duplicate entry') as Error & { code: string; errno: number };
      error.code = 'ER_DUP_ENTRY';
      error.errno = 1062;
      throw error;
    }
  }

  private update(rows: Row[], matcher: (row: Row) => boolean, patch: EnvVariablePatch): void {
    const row = rows.find(matcher);
    if (!row) return;
    if (patch.envKey !== undefined) row.envKey = patch.envKey;
    if (patch.envValue !== undefined) row.envValue = patch.envValue;
    if (patch.note !== undefined) row.note = patch.note;
  }

  async listSystem(): Promise<EnvVariable[]> { this.listCalls += 1; return this.system.map((r) => ({ ...r })); }
  async findSystemById(id: number) { return this.system.find((r) => r.id === id) ?? null; }
  async findSystemByKey(envKey: string) { return this.system.find((r) => r.envKey === envKey) ?? null; }
  async countSystem() { return this.system.length; }
  async insertSystem(row: EnvVariable) {
    this.checkUnique(this.system, (r) => r.envKey === row.envKey);
    const id = this.nextId();
    this.system.push({ ...row, id });
    return id;
  }
  async updateSystem(id: number, patch: EnvVariablePatch) {
    if (patch.envKey !== undefined) this.checkUnique(this.system, (r) => r.id !== id && r.envKey === patch.envKey);
    this.update(this.system, (r) => r.id === id, patch);
  }
  async deleteSystem(id: number) { this.system = this.system.filter((r) => r.id !== id); }

  async listUser(userId: number) { return this.users.filter((r) => r.userId === userId).map((r) => ({ ...r })); }
  async findUserById(userId: number, id: number) {
    return this.users.find((r) => r.userId === userId && r.id === id) ?? null;
  }
  async findUserByKey(userId: number, envKey: string) {
    return this.users.find((r) => r.userId === userId && r.envKey === envKey) ?? null;
  }
  async countUser(userId: number) { return this.users.filter((r) => r.userId === userId).length; }
  async insertUser(row: EnvVariable) {
    this.checkUnique(this.users, (r) => r.userId === row.userId && r.envKey === row.envKey);
    const id = this.nextId();
    this.users.push({ ...row, id });
    return id;
  }
  async updateUser(userId: number, id: number, patch: EnvVariablePatch) {
    if (patch.envKey !== undefined) {
      this.checkUnique(
        this.users,
        (r) => !(r.userId === userId && r.id === id) && r.userId === userId && r.envKey === patch.envKey,
      );
    }
    this.update(this.users, (r) => r.userId === userId && r.id === id, patch);
  }
  async deleteUser(userId: number, id: number) {
    this.users = this.users.filter((r) => !(r.userId === userId && r.id === id));
  }

  async listWorkspace(userId: number, workspacePath: string) {
    return this.workspaces
      .filter((r) => r.userId === userId && r.workspacePath === workspacePath)
      .map((r) => ({ ...r }));
  }
  async listWorkspaceByUser(userId: number) {
    return this.workspaces.filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }
  async findWorkspaceById(userId: number, id: number) {
    return this.workspaces.find((r) => r.userId === userId && r.id === id) ?? null;
  }
  async findWorkspaceByKey(userId: number, workspacePath: string, envKey: string) {
    return this.workspaces.find(
      (r) => r.userId === userId && r.workspacePath === workspacePath && r.envKey === envKey,
    ) ?? null;
  }
  async countWorkspace(userId: number, workspacePath: string) {
    return this.workspaces.filter((r) => r.userId === userId && r.workspacePath === workspacePath).length;
  }
  async insertWorkspace(row: EnvVariable) {
    this.checkUnique(
      this.workspaces,
      (r) => r.userId === row.userId && r.workspacePath === row.workspacePath && r.envKey === row.envKey,
    );
    const id = this.nextId();
    this.workspaces.push({ ...row, id });
    return id;
  }
  async updateWorkspace(userId: number, id: number, patch: EnvVariablePatch) {
    this.update(this.workspaces, (r) => r.userId === userId && r.id === id, patch);
  }
  async deleteWorkspace(userId: number, id: number) {
    this.workspaces = this.workspaces.filter((r) => !(r.userId === userId && r.id === id));
  }
}

function newService(options: { enabled?: boolean; repo?: FakeRepo } = {}) {
  const repo = options.repo ?? new FakeRepo();
  const service = new EnvVariableService(
    repo,
    SECRET,
    ROOT,
    { shellEnvVarsEnabled: async () => options.enabled ?? true },
    async (userId) => [`GIT_TOKEN_repo_${userId}`],
  );
  return { repo, service };
}

/** 断言 Promise 以指定业务错误码失败（避免重复执行创建动作）。 */
async function expectCode(promise: Promise<unknown>, code: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BusinessException);
  expect((caught as BusinessException).code).toBe(code);
}

describe('EnvVariableService', () => {
  it('encrypts values at rest and resolves plaintext only for injection', async () => {
    const { repo, service } = newService();
    const created = await service.createUser(7, { envKey: 'GITEA_TOKEN', envValue: 'super-secret' });
    expect(repo.users[0].envValue).not.toBe('super-secret');
    expect(repo.users[0].envValue).toContain(':');
    expect(created.envValue).not.toBe('super-secret');
    expect(await service.resolveForSession(7, null)).toEqual({ GITEA_TOKEN: 'super-secret' });
  });

  it('rejects invalid names, reserved keys and oversized values', async () => {
    const { service } = newService();
    await expectCode(service.createUser(1, { envKey: '1BAD', envValue: 'x' }), ErrorCode.PARAM_INVALID.code);
    await expectCode(service.createUser(1, { envKey: 'PATH', envValue: 'x' }), ErrorCode.ENV_VARIABLE_KEY_RESERVED.code);
    await expectCode(service.createUser(1, { envKey: 'home', envValue: 'x' }), ErrorCode.ENV_VARIABLE_KEY_RESERVED.code);
    await expectCode(
      service.createUser(1, { envKey: 'MAO_WORKSPACE_ROOT', envValue: 'x' }),
      ErrorCode.ENV_VARIABLE_KEY_RESERVED.code,
    );
    await expectCode(
      service.createUser(1, { envKey: 'TOO_LONG', envValue: 'x'.repeat(2049) }),
      ErrorCode.PARAM_INVALID.code,
    );
    // 多字节值按 UTF-8 字节计：1024 个汉字 = 3072 字节，加密后 base64 会超出 VARCHAR(4096)
    await expectCode(
      service.createUser(1, { envKey: 'TOO_LONG_CN', envValue: '中'.repeat(1024) }),
      ErrorCode.PARAM_INVALID.code,
    );
  });

  it('rejects duplicate keys and the 51st variable per scope', async () => {
    const { service } = newService();
    await service.createUser(1, { envKey: 'A', envValue: '1' });
    await expectCode(
      service.createUser(1, { envKey: 'A', envValue: '2' }),
      ErrorCode.ENV_VARIABLE_KEY_DUPLICATE.code,
    );
    for (let i = 0; i < 49; i += 1) {
      await service.createUser(1, { envKey: `K${i}`, envValue: 'v' });
    }
    await expectCode(
      service.createUser(1, { envKey: 'K50', envValue: 'v' }),
      ErrorCode.ENV_VARIABLE_LIMIT_EXCEEDED.code,
    );
  });

  it('requires value on update but allows explicit empty value', async () => {
    const { service } = newService();
    const created = await service.createUser(1, { envKey: 'X', envValue: 'v' });
    await expectCode(
      service.updateUser(1, created.id!, { envValue: undefined as unknown as string }),
      ErrorCode.PARAM_INVALID.code,
    );
    await service.updateUser(1, created.id!, { envValue: '' });
    expect(await service.resolveForSession(1, null)).toEqual({ X: '' });
  });

  it('merges layers with workspace > user > system', async () => {
    const { service } = newService();
    await service.createSystem({ envKey: 'SHARED', envValue: 'from-system' });
    await service.createSystem({ envKey: 'SYS_ONLY', envValue: 'sys' });
    await service.createUser(2, { envKey: 'SHARED', envValue: 'from-user' });
    await service.createUser(2, { envKey: 'USER_ONLY', envValue: 'user' });
    const workspace = `${ROOT}/repo-a`;
    await service.createWorkspace(2, { workspacePath: workspace, envKey: 'SHARED', envValue: 'from-workspace' });

    expect(await service.resolveForSession(2, workspace)).toEqual({
      SHARED: 'from-workspace',
      SYS_ONLY: 'sys',
      USER_ONLY: 'user',
    });
    expect(await service.resolveForSession(2, '/tmp/other-ws')).toEqual({
      SHARED: 'from-user',
      SYS_ONLY: 'sys',
      USER_ONLY: 'user',
    });
  });

  it('rejects workspace paths over the column width', async () => {
    const { service } = newService();
    await expectCode(
      service.createWorkspace(1, { workspacePath: `/${'a'.repeat(600)}`, envKey: 'X', envValue: 'v' }),
      ErrorCode.PARAM_INVALID.code,
    );
  });

  it('binds null / trailing-slash / whitespace-padded workspaces to the global root key', async () => {
    const { service } = newService();
    await service.createWorkspace(3, { workspacePath: ROOT, envKey: 'GLOBAL_WS', envValue: 'yes' });
    expect(await service.resolveForSession(3, null)).toEqual({ GLOBAL_WS: 'yes' });
    expect(await service.resolveForSession(3, '')).toEqual({ GLOBAL_WS: 'yes' });
    expect(await service.resolveForSession(3, `${ROOT}/`)).toEqual({ GLOBAL_WS: 'yes' });
    expect(await service.resolveForSession(3, `  ${ROOT}  `)).toEqual({ GLOBAL_WS: 'yes' });
  });

  it('reports the actually winning source in effective env, not the lowest priority duplicate', async () => {
    const { service } = newService();
    await service.createSystem({ envKey: 'SHARED', envValue: 'from-system', note: 'sys' });
    await service.createUser(12, { envKey: 'SHARED', envValue: 'from-user', note: 'user' });
    await service.createWorkspace(12, { workspacePath: ROOT, envKey: 'SHARED', envValue: 'from-ws', note: 'ws' });
    const result = await service.resolveEffectiveEnv(12, null);
    expect(result.items.find((item) => item.envKey === 'SHARED'))
      .toEqual({ envKey: 'SHARED', source: 'WORKSPACE', note: 'ws' });
    expect(result.totals).toMatchObject({ system: 0, user: 0, workspace: 1 });
    expect(JSON.stringify(result)).not.toContain('from-');
  });

  it('skips reserved and undecryptable rows instead of leaking or throwing', async () => {
    const { repo, service } = newService();
    repo.system.push({ id: 900, envKey: 'PATH', envValue: encryptAesCbc('/evil', SECRET), note: null });
    repo.system.push({ id: 901, envKey: 'BROKEN', envValue: 'not-a-ciphertext', note: null });
    await service.createSystem({ envKey: 'OK', envValue: 'fine' });
    expect(await service.resolveForSession(4, null)).toEqual({ OK: 'fine' });
    const effective = await service.resolveEffectiveEnv(4, null);
    expect(effective.items.some((item) => item.envKey === 'BROKEN')).toBe(false);
    expect(effective.items.some((item) => item.source === 'SYSTEM' && item.envKey === 'PATH')).toBe(false);
    expect(effective.items.some((item) => item.envKey === 'OK')).toBe(true);
  });

  it('returns nothing when the injection switch is off', async () => {
    const { service } = newService({ enabled: false });
    const repoService = newService();
    await repoService.service.createSystem({ envKey: 'S1', envValue: 'v' });
    // 关闭态下三层变量全部不注入，仅保留平台内置凭据
    await expect(service.resolveForSession(5, null)).resolves.toEqual({});
    await expect(repoService.service.resolveForSession(5, null)).resolves.toEqual({ S1: 'v' });
  });

  it('caches repeated reads inside the TTL and invalidates on write', async () => {
    const { repo, service } = newService();
    await service.createUser(6, { envKey: 'A', envValue: '1' });
    const before = repo.listCalls;
    await service.resolveForSession(6, null);
    await service.resolveForSession(6, null);
    expect(repo.listCalls - before).toBe(1);
    await service.createUser(6, { envKey: 'B', envValue: '2' });
    expect(await service.resolveForSession(6, null)).toEqual({ A: '1', B: '2' });
  });

  it('exposes effective env grouped by source without plaintext values', async () => {
    const { service } = newService();
    await service.createSystem({ envKey: 'SYS_A', envValue: 'sys-plaintext' });
    await service.createUser(8, { envKey: 'USER_A', envValue: 'user-plaintext', note: '我的变量' });
    await service.createWorkspace(8, { workspacePath: ROOT, envKey: 'WS_A', envValue: 'ws-plaintext' });
    const result = await service.resolveEffectiveEnv(8, null);
    expect(result.enabled).toBe(true);
    expect(result.items).toContainEqual({ envKey: 'SYS_A', source: 'SYSTEM', note: null });
    expect(result.items).toContainEqual({ envKey: 'USER_A', source: 'USER', note: '我的变量' });
    expect(result.items).toContainEqual({ envKey: 'WS_A', source: 'WORKSPACE', note: null });
    expect(result.items).toContainEqual({ envKey: 'GIT_TOKEN_repo_8', source: 'BUILTIN', note: null });
    expect(JSON.stringify(result)).not.toContain('plaintext');
    expect(result.totals).toMatchObject({ system: 1, user: 1, workspace: 1 });
  });

  it('does not expose platform config or secret-like keys under INHERITED', async () => {
    const previous = process.env.APP_FAKE_SECRET_FOR_ENV_TEST;
    const prevSettingsSecret = process.env.SETTINGS_SECRET;
    process.env.APP_FAKE_SECRET_FOR_ENV_TEST = 'leak';
    process.env.SETTINGS_SECRET = 'leak-too';
    try {
      const { service } = newService();
      const result = await service.resolveEffectiveEnv(9, null);
      expect(result.items.some((item) => item.envKey === 'APP_FAKE_SECRET_FOR_ENV_TEST')).toBe(false);
      expect(result.items.some((item) => item.envKey === 'SETTINGS_SECRET')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.APP_FAKE_SECRET_FOR_ENV_TEST;
      else process.env.APP_FAKE_SECRET_FOR_ENV_TEST = previous;
      if (prevSettingsSecret === undefined) delete process.env.SETTINGS_SECRET;
      else process.env.SETTINGS_SECRET = prevSettingsSecret;
    }
  });

  it('masks admin view by ciphertext length only', () => {
    expect(maskEnvValueForAdmin(null)).toBe('****');
    expect(maskEnvValueForAdmin('')).toBe('****');
    expect(maskEnvValueForAdmin('abc')).toBe('**** (3 chars)');
  });

  it('keeps scopes isolated per user', async () => {
    const { service } = newService();
    await service.createUser(10, { envKey: 'MINE', envValue: 'a' });
    expect(await service.resolveForSession(11, null)).toEqual({});
    const created = await service.createUser(10, { envKey: 'X', envValue: '1' });
    await expectCode(service.deleteUser(11, created.id!), ErrorCode.ENV_VARIABLE_NOT_FOUND.code);
  });

  it('maps a racing duplicate insert to ENV_VARIABLE_KEY_DUPLICATE', async () => {
    const { service, repo } = newService();
    // 模拟「校验时不存在、插入时被并发写入」：绕过 findUserByKey 的预检查
    repo.findUserByKey = async () => null;
    repo.users.push({ id: 777, userId: 1, envKey: 'RACE', envValue: 'cipher', note: null });
    await expectCode(
      service.createUser(1, { envKey: 'RACE', envValue: 'v' }),
      ErrorCode.ENV_VARIABLE_KEY_DUPLICATE.code,
    );
  });
});
