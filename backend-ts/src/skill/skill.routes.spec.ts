import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerSkillRoutes } from './skill.routes.js';
import { UserSkillService } from './user-skill.service.js';
import { SkillDocService } from './skill-doc.service.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { SkillSyncService } from '../harness/skill/skill-sync-service.js';
import type { SessionService } from '../session/session.service.js';
import type { AgentLookup } from '../session/types.js';

describe('skill routes', () => {
  it('listsAndReadsSkillDocsAndUserSkills', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'mao-sdoc-'));
    mkdirSync(join(skillsDir, 'demo'), { recursive: true });
    writeFileSync(join(skillsDir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\nHello\n');
    const userDir = await mkdtemp(join(tmpdir(), 'mao-user-s-'));
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
    });
    const list = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs' })).body);
    expect(list.data[0].name).toBe('demo');
    const detail = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs/demo' })).body);
    expect(detail.data.body).toBe('Hello');
    const missing = JSON.parse((await app.inject({ method: 'GET', url: '/v1/skill-docs/nope' })).body);
    expect(missing.code).toBe(404);
    const users = JSON.parse((await app.inject({ method: 'GET', url: '/v1/user-skills' })).body);
    expect(users.data).toEqual([]);
    const zip = await app.inject({ method: 'POST', url: '/v1/skills/sync-package?sessionId=1' });
    expect(zip.statusCode).toBe(200);
    expect(zip.headers['content-type']).toContain('application/zip');
    await app.close();
  });

  it('uploadKeepsSkillFolderPathFromMultipartFilename', async () => {
    const skillsDir = await mkdtemp(join(tmpdir(), 'mao-sdoc-'));
    const userDir = await mkdtemp(join(tmpdir(), 'mao-user-s-'));
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
});
