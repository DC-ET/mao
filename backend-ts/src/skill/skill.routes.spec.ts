import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { handleError } from '../common/http-error.js';
import { parseAssignUserIds, registerSkillRoutes } from './skill.routes.js';
import { UserSkillService } from './user-skill.service.js';
import { SkillDocService } from './skill-doc.service.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { SkillSyncService } from '../harness/skill/skill-sync-service.js';
import type { SessionService } from '../session/session.service.js';
import type { AgentLookup } from '../session/types.js';

describe('skill routes', () => {
  it('listsAndReadsSkillDocsAndUserSkills', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    mkdirSync(join(skillsDir, 'demo'), { recursive: true });
    writeFileSync(join(skillsDir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nHello\n');
    const userDir = useTmpDir('mao-user-s-');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 7, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService: {
        hasPermission: vi.fn(async () => true),
      },
      userLookup: {
        findByIds: vi.fn(async () => [{ id: 7, username: 'u7', displayName: 'U7' }]),
        listOptions: vi.fn(async () => [{ id: 7, username: 'u7', displayName: 'U7' }]),
      },
    });
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs' })).body);
    expect(list.data[0].name).toBe('demo');
    const detail = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs/demo' })).body);
    expect(detail.data.body).toBe('Hello');
    const missing = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs/nope' })).body);
    expect(missing.code).toBe(404);
    const users = JSON.parse((await app.inject({ method: 'GET', url: '/v1/user-skills' })).body);
    expect(users.data).toEqual([]);
    const adminSkills = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills' })).body);
    expect(adminSkills.data).toEqual([]);
    const zip = await app.inject({ method: 'POST', url: '/v1/skills/sync-package?sessionId=1' });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    await app.close();
  });

  it('listsAdminUserSkillsWithUsernamesAndChecksPermission', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    const userDir = useTmpDir('mao-user-s-');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nBody\n');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    const permissionService = { hasPermission: vi.fn(async () => true) };
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 7, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService,
      userLookup: {
        findByIds: vi.fn(async () => [{ id: 7, username: 'u7', displayName: 'U7' }]),
        listOptions: vi.fn(async () => [{ id: 7, username: 'u7', displayName: 'U7' }]),
      },
    });

    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills' })).body);
    expect(list.code).toBe(0);
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({
      name: 'mine',
      userId: 7,
      username: 'u7',
      displayName: 'U7',
    });

    const detail = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills/7/mine' })).body);
    expect(detail.data.body).toBe('Body');

    permissionService.hasPermission.mockResolvedValue(false);
    const denied = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills' })).body);
    expect(denied.code).toBe(1002);

    permissionService.hasPermission.mockResolvedValue(true);
    const deleted = JSON.parse((await app.inject({ method: 'DELETE', url: '/v1/admin/user-skills/7/mine' })).body);
    expect(deleted.code).toBe(0);
    const afterDelete = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills' })).body);
    expect(afterDelete.data).toEqual([]);
    await app.close();
  });

  it('rejectsSyncPackageForForeignSession', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    const userDir = useTmpDir('mao-user-s-');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 99, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService: {
        hasPermission: vi.fn(async () => true),
      },
      userLookup: {
        findByIds: vi.fn(async () => []),
        listOptions: vi.fn(async () => []),
      },
    });
    const zip = await app.inject({ method: 'POST', url: '/v1/skills/sync-package?sessionId=1' });
    expect(zip.statusCode).toBe(403);
    await app.close();
  });

  it('uploadKeepsSkillFolderPathFromMultipartFilename', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    const userDir = useTmpDir('mao-user-s-');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    await app.register(multipart);
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 7, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService: {
        hasPermission: vi.fn(async () => true),
      },
      userLookup: {
        findByIds: vi.fn(async () => []),
        listOptions: vi.fn(async () => []),
      },
    });

    const boundary = '----maoSkillUpload';
    const skillMd = '---\nname: demo-skill\ndescription: Demo skill\n---\nBody\n';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="demo-skill/SKILL.md"',
      'Content-Type: text/markdown',
      '',
      skillMd,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const res = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/user-skills/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })).body);
    expect(res.code).toBe(0);
    expect(res.data).toEqual(['demo-skill']);
    expect(existsSync(join(userDir, '7', 'demo-skill', 'SKILL.md'))).toBe(true);
    await app.close();
  });

  it('parsesAssignUserIds', () => {
    expect(parseAssignUserIds([])).toEqual({ ok: false, message: '请指定至少一个用户' });
    expect(parseAssignUserIds(['7, 8', '8'])).toEqual({ ok: true, ids: [7, 8] });
    expect(parseAssignUserIds(['[9,10]'])).toEqual({ ok: true, ids: [9, 10] });
    expect(parseAssignUserIds(['0']).ok).toBe(false);
    expect(parseAssignUserIds(['abc']).ok).toBe(false);
    expect(parseAssignUserIds(['[']).ok).toBe(false);
    expect(parseAssignUserIds([Array.from({ length: 101 }, (_, i) => String(i + 1)).join(',')]).ok).toBe(false);
  });

  it('assignsPersonalSkillToSelectedUsersWithoutTouchingSystemCatalog', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    const userDir = useTmpDir('mao-user-s-');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    await app.register(multipart);
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 1; done(); });
    const permissionService = { hasPermission: vi.fn(async () => true) };
    const known = new Map([
      [7, { id: 7, username: 'u7', displayName: 'U7' }],
      [8, { id: 8, username: 'u8', displayName: 'U8' }],
    ]);
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 1, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService,
      userLookup: {
        findByIds: vi.fn(async (ids: number[]) => ids.map((id) => known.get(id)).filter((user) => user != null)),
        listOptions: vi.fn(async () => [...known.values()]),
      },
    });

    const options = JSON.parse((await app.inject({ method: 'GET', url: '/v1/admin/user-skills/options/users' })).body);
    expect(options.code).toBe(0);
    expect(options.data.map((user: { id: number }) => user.id)).toEqual([7, 8]);

    const boundary = '----maoAssignSkill';
    const skillMd = '---\nname: team-skill\ndescription: Team only\n---\nBody\n';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="userIds"',
      '',
      '7,8',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="team-skill/SKILL.md"',
      'Content-Type: text/markdown',
      '',
      skillMd,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const uploaded = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/user-skills/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })).body);
    expect(uploaded.code).toBe(0);
    expect(uploaded.data.skills).toEqual(['team-skill']);
    expect(uploaded.data.users.map((user: { id: number }) => user.id)).toEqual([7, 8]);
    expect(existsSync(join(userDir, '7', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, '8', 'team-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'team-skill'))).toBe(false);

    const missingUser = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/user-skills/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="userIds"',
        '',
        '99',
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="team-skill/SKILL.md"',
        'Content-Type: text/markdown',
        '',
        skillMd,
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    })).body);
    expect(missingUser.code).toBe(400);
    expect(missingUser.message).toContain('99');
    expect(existsSync(join(userDir, '99'))).toBe(false);

    const noUsers = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/user-skills/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="team-skill/SKILL.md"',
        'Content-Type: text/markdown',
        '',
        skillMd,
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    })).body);
    expect(noUsers.code).toBe(400);

    rmSync(join(userDir, '8'), { recursive: true, force: true });
    writeFileSync(join(userDir, '8'), 'not-a-directory');
    const partial = JSON.parse((await app.inject({
      method: 'POST',
      url: '/v1/admin/user-skills/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    })).body);
    expect(partial.code).toBe(500);
    expect(partial.message).toContain('已写入用户 7');
    expect(partial.data.users.map((user: { id: number }) => user.id)).toEqual([7]);
    expect(existsSync(join(userDir, '7', 'team-skill', 'SKILL.md'))).toBe(true);

    permissionService.hasPermission.mockResolvedValue(false);
    const denied = await app.inject({ method: 'GET', url: '/v1/admin/user-skills/options/users' });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).code).toBe(1002);
    await app.close();
  });

  it('rejectsTruncatedAdminUploadWithoutWritingSkills', async () => {
    const skillsDir = useTmpDir('mao-sdoc-');
    const userDir = useTmpDir('mao-user-s-');
    const loader = new SkillLoader(new PathSandbox(skillsDir), skillsDir, 1);
    const app = Fastify();
    await app.register(multipart, { limits: { files: 1 } });
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 1; done(); });
    registerSkillRoutes(app, {
      userSkillService: new UserSkillService(userDir),
      skillDocService: new SkillDocService(loader),
      skillSyncService: {
        writeSyncZip: vi.fn(async (_a, _s, out) => { out.end(); }),
      } as unknown as SkillSyncService,
      sessionService: {
        getSession: vi.fn(async () => ({ id: 1, userId: 1, agentId: 9 })),
      } as unknown as SessionService,
      agentService: {
        removeSkillNameFromAll: vi.fn(async () => 0),
      } as never,
      agentLookup: {
        findById: vi.fn(async () => ({ id: 9, name: 'A' })),
      } as unknown as AgentLookup,
      permissionService: { hasPermission: vi.fn(async () => true) },
      userLookup: {
        findByIds: vi.fn(async () => [{ id: 7, username: 'u7', displayName: 'U7' }]),
        listOptions: vi.fn(async () => []),
      },
    });

    const boundary = '----maoTruncatedSkill';
    const skillMd = '---\nname: team-skill\ndescription: Team only\n---\nBody\n';
    const filePart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="team-skill/SKILL.md"',
      'Content-Type: text/markdown',
      '',
      skillMd,
    ].join('\r\n');
    const extraPart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="team-skill/extra.txt"',
      'Content-Type: text/plain',
      '',
      'extra',
    ].join('\r\n');
    const userPart = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="userIds"',
      '',
      '7',
    ].join('\r\n');
    for (const payload of [
      [userPart, filePart, extraPart, `--${boundary}--`, ''].join('\r\n'),
      [filePart, extraPart, userPart, `--${boundary}--`, ''].join('\r\n'),
    ]) {
      const aborted = JSON.parse((await app.inject({
        method: 'POST',
        url: '/v1/admin/user-skills/upload',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      })).body);
      expect(aborted.code).toBe(400);
      expect(aborted.message).toContain('未写入');
      expect(existsSync(join(userDir, '7', 'team-skill'))).toBe(false);
    }
    await app.close();
  });
});
