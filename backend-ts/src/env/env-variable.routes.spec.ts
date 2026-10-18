import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { encryptAesCbc } from '../crypto/aes-cbc.js';
import { EnvVariableService } from './env-variable.service.js';
import { registerAdminEnvVariableRoutes, registerEnvVariableRoutes } from './env-variable.routes.js';
import type { EnvVariable, EnvVariablePatch, EnvVariableRepository } from './types.js';

const SECRET = 'routes-test-secret';
const ROOT = '/tmp/mao-env-routes-workspace';

class MemoryRepo implements EnvVariableRepository {
  system: EnvVariable[] = [];
  users: EnvVariable[] = [];
  workspaces: EnvVariable[] = [];
  private seq = 1;

  private id(): number { return this.seq++; }
  private isDup(rows: EnvVariable[], match: (row: EnvVariable) => boolean): boolean { return rows.some(match); }
  private patch(rows: EnvVariable[], match: (row: EnvVariable) => boolean, p: EnvVariablePatch): void {
    const row = rows.find(match);
    if (!row) return;
    if (p.envKey !== undefined) row.envKey = p.envKey;
    if (p.envValue !== undefined) row.envValue = p.envValue;
    if (p.note !== undefined) row.note = p.note;
  }

  async listSystem() { return this.system.slice(); }
  async findSystemById(id: number) { return this.system.find((r) => r.id === id) ?? null; }
  async findSystemByKey(envKey: string) { return this.system.find((r) => r.envKey === envKey) ?? null; }
  async countSystem() { return this.system.length; }
  async insertSystem(row: EnvVariable) { const id = this.id(); this.system.push({ ...row, id }); return id; }
  async updateSystem(id: number, p: EnvVariablePatch) { this.patch(this.system, (r) => r.id === id, p); }
  async deleteSystem(id: number) { this.system = this.system.filter((r) => r.id !== id); }

  async listUser(userId: number) { return this.users.filter((r) => r.userId === userId); }
  async findUserById(userId: number, id: number) {
    return this.users.find((r) => r.userId === userId && r.id === id) ?? null;
  }
  async findUserByKey(userId: number, envKey: string) {
    return this.users.find((r) => r.userId === userId && r.envKey === envKey) ?? null;
  }
  async countUser(userId: number) { return this.users.filter((r) => r.userId === userId).length; }
  async insertUser(row: EnvVariable) { const id = this.id(); this.users.push({ ...row, id }); return id; }
  async updateUser(userId: number, id: number, p: EnvVariablePatch) {
    this.patch(this.users, (r) => r.userId === userId && r.id === id, p);
  }
  async deleteUser(userId: number, id: number) {
    this.users = this.users.filter((r) => !(r.userId === userId && r.id === id));
  }

  async listWorkspace(userId: number, workspacePath: string) {
    return this.workspaces.filter((r) => r.userId === userId && r.workspacePath === workspacePath);
  }
  async listWorkspaceByUser(userId: number) { return this.workspaces.filter((r) => r.userId === userId); }
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
  async insertWorkspace(row: EnvVariable) { const id = this.id(); this.workspaces.push({ ...row, id }); return id; }
  async updateWorkspace(userId: number, id: number, p: EnvVariablePatch) {
    this.patch(this.workspaces, (r) => r.userId === userId && r.id === id, p);
  }
  async deleteWorkspace(userId: number, id: number) {
    this.workspaces = this.workspaces.filter((r) => !(r.userId === userId && r.id === id));
  }

  /** 测试辅助：直接塞一行（密文由调用方给）。 */
  seedUser(userId: number, envKey: string, envValue: string, note: string | null = null): void {
    this.users.push({ id: this.id(), userId, envKey, envValue, note });
  }

  seedWorkspace(userId: number, workspacePath: string, envKey: string, envValue: string): void {
    this.workspaces.push({ id: this.id(), userId, workspacePath, envKey, envValue, note: null });
  }
}

function buildApp(options: { permissions?: string[]; sessions?: Record<number, { userId: number; workspace?: string | null }> } = {}) {
  const repo = new MemoryRepo();
  const service = new EnvVariableService(
    repo,
    SECRET,
    ROOT,
    { shellEnvVarsEnabled: async () => true },
  );
  const permissions = options.permissions ?? ['settings:read', 'settings:write', 'user:read'];
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (request, _reply, done) => {
    request.userId = 9;
    done();
  });
  registerEnvVariableRoutes(app, {
    envVariableService: service,
    sessionLookup: {
      findById: async (id: number) => options.sessions?.[id] ?? null,
    },
  });
  registerAdminEnvVariableRoutes(app, {
    envVariableService: service,
    permissionService: {
      hasPermission: vi.fn(async (_userId: number, code: string) => permissions.includes(code)),
    },
    userLookup: { findById: async (id: number) => ({ username: `user${id}` }) },
  });
  return { app, repo };
}

describe('env variable routes', () => {
  it('creates and lists user variables without exposing values', async () => {
    const { app } = buildApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/user/env-variables',
      payload: { envKey: 'NPM_REGISTRY', envValue: 'https://mirror.internal', note: '镜像' },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json().data;
    expect(created.envKey).toBe('NPM_REGISTRY');
    expect(created.note).toBe('镜像');
    expect(JSON.stringify(created)).not.toContain('mirror.internal');

    const list = await app.inject({ method: 'GET', url: '/v1/user/env-variables' });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].envValue).toBeUndefined();

    const update = await app.inject({
      method: 'PUT',
      url: `/v1/user/env-variables/${created.id}`,
      payload: { envValue: 'https://mirror2.internal' },
    });
    expect(update.statusCode).toBe(200);

    const removed = await app.inject({ method: 'DELETE', url: `/v1/user/env-variables/${created.id}` });
    expect(removed.statusCode).toBe(200);
  });

  it('rejects an update that omits the value instead of silently clearing it', async () => {
    const { app, repo } = buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/user/env-variables',
      payload: { envKey: 'KEEP_ME', envValue: 'original' },
    });
    const id = created.json().data.id;
    const cipherBefore = repo.users.find((row) => row.id === id)?.envValue;

    const response = await app.inject({
      method: 'PUT',
      url: `/v1/user/env-variables/${id}`,
      payload: { note: 'only note' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 2001 });
    expect(repo.users.find((row) => row.id === id)?.envValue).toBe(cipherBefore);
  });

  it('lists workspace variables by normalized workspace path', async () => {
    const { app, repo } = buildApp();
    repo.seedWorkspace(9, ROOT, 'WS_ONLY', encryptAesCbc('v', SECRET));
    const { statusCode, json } = await app.inject({ method: 'GET', url: `/v1/user/workspace-env-variables?workspace=${ROOT}/` });
    expect(statusCode).toBe(200);
    expect(json().data.map((row: { envKey: string }) => row.envKey)).toEqual(['WS_ONLY']);
  });

  it('returns effective env only for the session owner', async () => {
    const { app } = buildApp({ sessions: { 5: { userId: 99, workspace: ROOT } } });
    const forbidden = await app.inject({ method: 'GET', url: '/v1/sessions/5/effective-env' });
    expect(forbidden.statusCode).toBe(403);

    const { app: ownApp } = buildApp({ sessions: { 6: { userId: 9, workspace: ROOT } } });
    const ok = await ownApp.inject({ method: 'GET', url: '/v1/sessions/6/effective-env' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ enabled: true, totals: expect.objectContaining({ system: 0 }) });
  });

  it('enforces settings permissions for system variables', async () => {
    const { app } = buildApp({ permissions: [] });
    const list = await app.inject({ method: 'GET', url: '/v1/admin/system-env-variables' });
    expect(list.statusCode).toBe(403);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/admin/system-env-variables',
      payload: { envKey: 'ARTIFACTORY_URL', envValue: 'https://x' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('lets admins read user variables masked, with no write route', async () => {
    const { app, repo } = buildApp();
    repo.seedUser(42, 'GITEA_TOKEN', encryptAesCbc('abcdefgh', SECRET), '私有 token');
    repo.seedWorkspace(42, ROOT, 'JAVA_HOME', encryptAesCbc('/opt/jdk', SECRET));

    const userList = await app.inject({ method: 'GET', url: '/v1/admin/users/42/env-variables' });
    expect(userList.statusCode).toBe(200);
    const userRow = userList.json().data[0];
    expect(userRow).toMatchObject({ userId: 42, username: 'user42', envKey: 'GITEA_TOKEN', note: '私有 token' });
    expect(userRow.maskedValue).toMatch(/^\*\*\*\* \(\d+ chars\)$/);
    expect(JSON.stringify(userRow)).not.toContain('abcdefgh');

    const wsList = await app.inject({ method: 'GET', url: `/v1/admin/users/42/workspace-env-variables?workspace=${ROOT}` });
    expect(wsList.statusCode).toBe(200);
    expect(wsList.json().data[0]).toMatchObject({ workspacePath: ROOT, envKey: 'JAVA_HOME' });

    const all = await app.inject({ method: 'GET', url: '/v1/admin/users/42/workspace-env-variables' });
    expect(all.json().data).toHaveLength(1);

    // 管理员不可代配用户变量：写路由必须不存在
    const attempted = await app.inject({
      method: 'POST',
      url: '/v1/admin/users/42/env-variables',
      payload: { envKey: 'X', envValue: 'y' },
    });
    expect(attempted.statusCode).toBe(404);
  });

  it('rejects reserved keys through the API with a clear code', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/user/env-variables',
      payload: { envKey: 'LD_PRELOAD', envValue: '/tmp/evil.so' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ code: 3050 });
  });
});
