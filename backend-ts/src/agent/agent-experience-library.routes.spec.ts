import Fastify from 'fastify';
import { join } from 'node:path';
import { utimesSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { registerAgentExperienceLibraryRoutes } from './agent-experience-library.routes.js';
import { ExperienceIndexService, EXPERIENCE_INDEX_FILE } from '../harness/experience/experience-index.service.js';

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
  const agentRepository = { findByIds: vi.fn(async () => [agent]) };
  const permissionService = { hasPermission: vi.fn(async () => hasPermission) };
  const experienceIndexService = new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience'));
  registerAgentExperienceLibraryRoutes(fastify, {
    agentService: agentService as never,
    agentRepository,
    experienceIndexService,
    permissionService,
  });
  return { app: fastify, agentService, agentRepository, permissionService, experienceIndexService };
}

/** 写一篇子文档并指定 mtime（updatedAt 排序/筛选依赖文件时间）。 */
function seedDoc(svc: ExperienceIndexService, agentId: number, fileName: string, content: string, mtime?: Date): string {
  const dir = svc.dirFor(agentId);
  svc.writeDoc(dir, fileName, content);
  if (mtime) utimesSync(join(dir, fileName), mtime, mtime);
  return fileName;
}

const DOC_A = '---\ntitle: MySQL 死锁\nkeywords: mysql, 死锁\nsummary: 排查\napplicable: MySQL 8\nlast_verified: 2026-09-01\n---\nbody';
const DOC_B = '---\ntitle: 飞书回滚\nkeywords: mysql\nlast_verified: 2026-10-15\n---\nbody';
const DOC_C = '---\ntitle: 中文逗号\nkeywords: k1，k2、k3；k1\n---\nbody';
const DOC_RAW = 'no frontmatter at all';

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

  it('lists docs, reads/writes/deletes a doc and rebuilds index', async () => {
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
      expect(data.total).toBe(1);
      expect(data.page).toBe(1);
      expect(data.keywords).toEqual([{ tag: 'k', count: 1 }]);

      const index = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/index' });
      expect(index.json().data).toMatchObject({ fileName: EXPERIENCE_INDEX_FILE, docCount: 1 });
      expect(index.json().data.content).toContain('2026-10-24-t.md');

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

  it('paginates, sorts, searches and filters docs server-side', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      const svc = experienceIndexService;
      seedDoc(svc, 1, '2026-10-01-a.md', DOC_A, new Date('2026-10-01T08:00:00Z'));
      seedDoc(svc, 1, '2026-10-15-b.md', DOC_B, new Date('2026-10-15T08:00:00Z'));
      seedDoc(svc, 1, '2026-11-01-raw.md', DOC_RAW, new Date('2026-11-01T08:00:00Z'));

      // 分页：size=2 → 第 1 页 2 篇 / 第 2 页 1 篇；越界页为空
      const page1 = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?size=2' })).json().data;
      expect(page1.total).toBe(3);
      expect(page1.docs).toHaveLength(2);
      const page2 = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?size=2&page=2' })).json().data;
      expect(page2.docs).toHaveLength(1);
      const page9 = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?size=2&page=9' })).json().data;
      expect(page9.docs).toHaveLength(0);

      // 排序：updatedAt 升序最旧在前；sizeBytes 升序
      const byTime = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?sort=updatedAt&order=asc' })).json().data;
      expect(byTime.docs.map((d: { fileName: string }) => d.fileName)).toEqual(['2026-10-01-a.md', '2026-10-15-b.md', '2026-11-01-raw.md']);
      const bySize = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?sort=sizeBytes&order=asc' })).json().data;
      expect(bySize.docs[0].sizeBytes).toBeLessThanOrEqual(bySize.docs[1].sizeBytes);

      // 关键词搜索：命中 keywords 与 summary（大小写不敏感包含）
      const byKw = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?keyword=mysql' })).json().data;
      expect(byKw.total).toBe(2);
      const bySummary = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?keyword=%E6%8E%92%E6%9F%A5' })).json().data;
      expect(bySummary.total).toBe(1);
      expect(bySummary.docs[0].fileName).toBe('2026-10-01-a.md');

      // tag 精确匹配：keywords: mysql, 死锁 中取「死锁」只命中 a
      const byTag = (await app.inject({ method: 'GET', url: `/v1/agents/1/experience-library/docs?tag=${encodeURIComponent('死锁')}` })).json().data;
      expect(byTag.total).toBe(1);
      expect(byTag.docs[0].fileName).toBe('2026-10-01-a.md');

      // 最后验证区间：空值文档不命中
      const verified = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?verifiedFrom=2026-09-15' })).json().data;
      expect(verified.total).toBe(1);
      expect(verified.docs[0].fileName).toBe('2026-10-15-b.md');

      // 更新时间区间（文件 mtime）
      const updated = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?updatedFrom=2026-10-10&updatedTo=2026-10-31' })).json().data;
      expect(updated.total).toBe(1);
      expect(updated.docs[0].fileName).toBe('2026-10-15-b.md');

      // 异常文档：无 frontmatter（五字段全空）/ 无标题
      const noFm = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?abnormal=no-frontmatter' })).json().data;
      expect(noFm.docs.map((d: { fileName: string }) => d.fileName)).toEqual(['2026-11-01-raw.md']);
      const noTitle = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?abnormal=no-title' })).json().data;
      expect(noTitle.total).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('sorts empty title/lastVerified docs to the end in both directions', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      seedDoc(experienceIndexService, 1, '2026-10-01-a.md', DOC_A);
      seedDoc(experienceIndexService, 1, '2026-10-02-raw.md', DOC_RAW);
      const asc = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?sort=title&order=asc' })).json().data;
      expect(asc.docs.at(-1).fileName).toBe('2026-10-02-raw.md');
      const desc = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?sort=title&order=desc' })).json().data;
      expect(desc.docs.at(-1).fileName).toBe('2026-10-02-raw.md');
    } finally {
      await app.close();
    }
  });

  it('returns group counts and keyword facets with chinese-comma splitting', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      const svc = experienceIndexService;
      seedDoc(svc, 1, '2026-10-01-a.md', DOC_A);
      seedDoc(svc, 1, '2026-10-15-b.md', DOC_B);
      seedDoc(svc, 1, '2026-11-01-c.md', DOC_C);
      seedDoc(svc, 1, '2026-11-02-raw.md', DOC_RAW);

      const byMonth = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?groupBy=month&size=1' })).json().data;
      // 组计数为过滤后全量口径（与分页无关）：10 月 2 篇、11 月 2 篇，月份倒序
      expect(byMonth.groupCounts).toEqual([{ key: '2026-11', count: 2 }, { key: '2026-10', count: 2 }]);
      // facets 按计数倒序：mysql 命中 2 篇居首；中文逗号/顿号/分号拆分且去重（k1 只出现一次）
      const tags: string[] = byMonth.keywords.map((k: { tag: string }) => k.tag);
      expect(tags[0]).toBe('mysql');
      for (const tag of ['k1', 'k2', 'k3', '死锁']) expect(tags).toContain(tag);
      expect(byMonth.keywords.find((k: { tag: string }) => k.tag === 'mysql').count).toBe(2);

      const byKeyword = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?groupBy=keyword' })).json().data;
      expect(byKeyword.groupCounts[0]).toEqual({ key: 'mysql', count: 2 });

      // tag 筛选后 groupCounts 随过滤口径收缩
      const filtered = (await app.inject({ method: 'GET', url: `/v1/agents/1/experience-library/docs?tag=mysql&groupBy=month` })).json().data;
      expect(filtered.groupCounts).toEqual([{ key: '2026-10', count: 2 }]);
    } finally {
      await app.close();
    }
  });

  it('filters updatedAt by UTC+8 date boundary consistent with admin display', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      // 2026-10-14T20:00:00Z = 北京时间 2026-10-15 04:00：按 +08:00 口径应落在 10-15（UTC 切片会错判为 10-14）
      seedDoc(experienceIndexService, 1, '2026-10-15-bj.md', DOC_A, new Date('2026-10-14T20:00:00Z'));
      const from = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?updatedFrom=2026-10-15' })).json().data;
      expect(from.total).toBe(1);
      const to = (await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs?updatedTo=2026-10-14' })).json().data;
      expect(to.total).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects invalid list params with PARAM_INVALID', async () => {
    const { app } = makeApp(true);
    try {
      for (const query of [
        'size=200', 'size=0', 'page=0', 'page=abc',
        'sort=bogus', 'order=up', 'groupBy=year', 'abnormal=weird',
        'verifiedFrom=2026/01/01', 'updatedTo=2026-1-1',
        `keyword=${encodeURIComponent('k'.repeat(201))}`,
      ]) {
        const res = await app.inject({ method: 'GET', url: `/v1/agents/1/experience-library/docs?${query}` });
        expect(res.json().code, query).not.toBe(0);
      }
    } finally {
      await app.close();
    }
  });

  it('overview joins agent names and treats soft-deleted/missing agents as orphans', async () => {
    const { app, agentRepository, agentService, experienceIndexService } = makeApp(true);
    try {
      seedDoc(experienceIndexService, 1, '2026-10-24-a.md', DOC_A);
      seedDoc(experienceIndexService, 99, '2026-10-25-orphan.md', DOC_B);

      const res = await app.inject({ method: 'GET', url: '/v1/agents/experience-library/overview' });
      const data = res.json().data;
      expect(data.libraries).toEqual([{
        agentId: 1, agentName: 'A', enabled: true,
        docCount: 1, totalBytes: expect.any(Number), lastUpdatedAt: expect.any(String),
      }]);
      // 目录存在但 findByIds（过滤软删）查不到 → 孤儿，不带名称
      expect(data.orphans).toEqual([{
        agentId: 99, docCount: 1, totalBytes: expect.any(Number), lastUpdatedAt: expect.any(String),
      }]);
      // 目录枚举顺序不定，只断言集合内容
      expect(agentRepository.findByIds).toHaveBeenCalledWith(expect.arrayContaining([1, 99]));
      expect(agentRepository.findByIds.mock.calls[0][0]).toHaveLength(2);
      // overview 是静态段，不落进 :id 路由（getAgent 未被调用）
      expect(agentService.getAgent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('overview requires agent:read permission', async () => {
    const { app, permissionService } = makeApp(false);
    try {
      const res = await app.inject({ method: 'GET', url: '/v1/agents/experience-library/overview' });
      expect(res.statusCode).toBe(403);
      expect(permissionService.hasPermission).toHaveBeenCalledWith(7, 'agent:read');
    } finally {
      await app.close();
    }
  });

  it('overview tolerates non-numeric and symlinked directories', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      const { mkdirSync, symlinkSync } = await import('node:fs');
      const root = experienceIndexService.getRoot();
      mkdirSync(join(root, 'not-a-number'), { recursive: true });
      mkdirSync(join(root, 'real-dir'), { recursive: true });
      symlinkSync(join(root, 'real-dir'), join(root, '999'), 'dir');
      const res = await app.inject({ method: 'GET', url: '/v1/agents/experience-library/overview' });
      expect(res.json().data.libraries).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('rejects traversal, non-md names and INDEX.md writes', async () => {
    const { app } = makeApp(true);
    try {
      for (const file of ['../escape.md', 'a/b.md', 'notes.txt', 'INDEX.md', 'index.md', 'INDEX.MD']) {
        const res = await app.inject({
          method: 'PUT', url: '/v1/agents/1/experience-library/docs/content',
          payload: { fileName: file, content: 'x' },
        });
        expect(res.json().code).not.toBe(0);
      }
      for (const file of ['INDEX.md', 'index.md']) {
        expect((await app.inject({ method: 'DELETE', url: `/v1/agents/1/experience-library/docs?file=${encodeURIComponent(file)}` })).json().code).not.toBe(0);
      }
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
      agentRepository: { findByIds: vi.fn(async () => []) },
      experienceIndexService: new ExperienceIndexService(join(useTmpDir('exp-routes-'), 'agent-experience')),
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    const res = await fastify.inject({ method: 'GET', url: '/v1/agents/99/experience-library/docs' });
    expect(res.json().code).not.toBe(0);
    await fastify.close();
  });

  it('writes docs from raw fs and the list still reflects them (ensureFresh self-heal)', async () => {
    const { app, experienceIndexService } = makeApp(true);
    try {
      // shell 旁路写入（不经 writeDoc）：列表请求经 ensureFresh 自愈
      const dir = experienceIndexService.dirFor(1);
      experienceIndexService.ensureFresh(dir);
      writeFileSync(join(dir, '2026-11-01-bypass.md'), '---\ntitle: 旁路\n---\nbody');
      const list = await app.inject({ method: 'GET', url: '/v1/agents/1/experience-library/docs' });
      expect(list.json().data.total).toBe(1);
      expect(list.json().data.docs[0].fileName).toBe('2026-11-01-bypass.md');
    } finally {
      await app.close();
    }
  });
});
