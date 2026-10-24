import Fastify from 'fastify';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAgentExperienceLibraryRoutes } from './agent-experience-library.routes.js';
import { ExperienceIndexService } from '../harness/experience/experience-index.service.js';

const AGENT = { id: 1, name: 'A', systemPrompt: 'p', experienceLibraryEnabled: 1 };

function makeApp(hasPermission: boolean, agent = AGENT) {
  const fastify = Fastify();
  fastify.setErrorHandler(handleError);
  fastify.addHook('preHandler', (req, _r, done) => {
    req.userId = 7;
    done();
  });
  const agentService = {
    getAgent: vi.fn(async () => agent),
    setExperienceLibraryEnabled: vi.fn(async (id: number, enabled: boolean) => ({
      ...agent, id, experienceLibraryEnabled: enabled ? 1 : 0,
    })),
  };
  const permissionService = { hasPermission: vi.fn(async () => hasPermission) };
  const experienceIndexService = new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience'));
  registerAgentExperienceLibraryRoutes(fastify, { agentService: agentService as never, experienceIndexService, permissionService });
  return { app: fastify, agentService, permissionService, experienceIndexService };
}

describe('agent experience library routes', () => {
  it('write endpoints require agent:write while list/content read only requires login', async () => {
    const { app, permissionService, agentService } = makeApp(false);
    try {
      expect((await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs' })).statusCode).toBe(200);
      expect(agentService.getAgent).toHaveBeenCalledWith(1);
      for (const [method, url] of [
        ['PUT', '/v1/agents/1/experience-library/docs/content'],
        ['DELETE', '/v1/agents/1/experience-library/docs?file=a.md'],
        ['POST', '/v1/agents/1/experience-library/index/rebuild'],
        ['PATCH', '/v1/agents/1/experience-library'],
      ] as const) {
        expect((await app.inject({ method, url })).statusCode).toBe(403);
      }
      expect(permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:write');
    } finally {
      await app.close();
    }
  });

  it('toggles enabled via PATCH', async () => {
    const { app } = makeApp(true);
    try {
      const res = await app.inject({
        method: 'PATCH', url: '/v1/agents/1/experience-library', payload: { enabled: false },
      });
      expect(res.json().data).toEqual({ enabled: false });
      const invalid = await app.inject({ method: 'PATCH', url: '/v1/agents/1/experience-library', payload: { enabled: 'yes' } });
      expect(invalid.json().code).not.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('lists docs with index content, reads/writes/deletes a doc and rebuilds index', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      const put = await app.inject({
        method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
        payload: { fileName: '2026-10-24-t.md', content: '---\ntitle: T\nkeywords: k\n---\nbody' },
      });
      expect(put.json().code).toBe(0);

      const list = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs' });
      const data = list.json().data;
      expect(data.enabled).toBe(true);
      expect(data.docs).toHaveLength(1);
      expect(data.docs[0]).toMatchObject({ fileName: '2026-10-24-t.md', title: 'T', keywords: 'k' });
      expect(data.indexContent).toContain('2026-10-24-t.md');

      const read = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs/content?file=2026-10-24-t.md' });
      expect(read.json().data.content).toContain('body');
      expect((await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs/content?file=nope.md' })).json().code).not.toBe(0);

      const rebuild = await app.inject({ method: 'POST', url: '/v1/agents/1/experience-library/index/rebuild' });
      expect(rebuild.json().code).toBe(0);

      const del = await app.inject({ method: 'DELETE', url: '/v1/agents/1/experience-library/docs?file=2026-10-24-t.md' });
      expect(del.json().code).toBe(0);
      expect(experienceIndexService.listDocs(experienceIndexService.dirFor(1))).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects traversal, non-md names and INDEX.md writes', async () => {
    const { app } = makeApp(true);
    try {
      for (const file of ['../escape.md', 'a/b.md', 'notes.txt', 'INDEX.md']) {
        const res = await app.inject({
          method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
          payload: { fileName: file, content: 'x' },
        });
        expect(res.json().code).not.toBe(0);
      }
      expect((await app.inject({ method: 'DELETE', url: '/v1/agents/1/experience-library/docs?file=INDEX.md' })).json().code).not.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns 404-shaped business error for missing agent', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    const notFound = { getAgent: vi.fn(async () => { throw new BusinessException(ErrorCode.AGENT_NOT_FOUND); }) };
    registerAgentExperienceLibraryRoutes(fastify, {
      agentService: notFound as never,
      experienceIndexService: new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience')),
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    const res = await fastify.inject({ method: 'GET', url: '/v1/agents/99/experience-library/docs' });
    expect(res.json().code).not.toBe(0);
    await fastify.close();
  });
});
