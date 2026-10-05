import Fastify from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { McpSecretCipher } from '../harness/mcp/crypto/mcp-secret-cipher.js';
import { registerAgentBundleRoutes } from './agent-bundle.routes.js';
import {
  AgentBundleService, BUNDLE_FETCH_MAX_BYTES, computeBundleContentHash, fetchBundleFromUrl, validateSourceUrl,
} from './agent-bundle.service.js';
import { BUNDLE_FORMAT, type AgentBundle } from './agent-bundle.types.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import type { Agent } from './types.js';

// ---------------------------------------------------------------- 纯函数：contentHash

describe('computeBundleContentHash', () => {
  function sampleBundle(overrides: Partial<AgentBundle> = {}): AgentBundle {
    return {
      format: BUNDLE_FORMAT,
      formatVersion: 1,
      exportedAt: '2026-10-05T00:00:00.000Z',
      agent: { name: '评审员', systemPrompt: '你是评审员' },
      experiences: [{ content: 'a', sortOrder: 0, enabled: true }],
      suggestedQuestions: [],
      skills: [{ name: 's1', include: 'reference' }],
      mcpServers: [],
      ...overrides,
    };
  }

  it('同内容同 hash；exportedAt 变化不影响；键顺序不影响', () => {
    const a = computeBundleContentHash(sampleBundle());
    const b = computeBundleContentHash(sampleBundle({ exportedAt: '2027-01-01T10:00:00.000Z' }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);

    const reordered = sampleBundle({
      agent: { systemPrompt: '你是评审员', name: '评审员' },
      experiences: [{ enabled: true, sortOrder: 0, content: 'a' }],
    }) as AgentBundle;
    expect(computeBundleContentHash(reordered)).toBe(a);
  });

  it('内容变化 hash 变化；数组顺序变化 hash 变化（数组保序）', () => {
    const base = computeBundleContentHash(sampleBundle());
    expect(computeBundleContentHash(sampleBundle({ agent: { name: '评审员', systemPrompt: '改动' } }))).not.toBe(base);
    expect(computeBundleContentHash(sampleBundle({
      experiences: [{ content: 'a', sortOrder: 0, enabled: true }, { content: 'b', sortOrder: 1, enabled: true }],
    }))).not.toBe(computeBundleContentHash(sampleBundle({
      experiences: [{ content: 'b', sortOrder: 1, enabled: true }, { content: 'a', sortOrder: 0, enabled: true }],
    })));
  });
});

// ---------------------------------------------------------------- fetchBundleFromUrl / validateSourceUrl

function httpResponse(status: number, bodyText: string | null, headers: Record<string, string> = {}): unknown {
  const encoder = new TextEncoder();
  const stream = bodyText == null ? null : new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(bodyText));
      controller.close();
    },
  });
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), body: stream };
}

function validBundleJson(systemPrompt = '你是评审员'): string {
  return JSON.stringify({
    format: BUNDLE_FORMAT, formatVersion: 1, exportedAt: '2026-10-05T00:00:00.000Z',
    agent: { name: '评审员', systemPrompt },
    experiences: [], suggestedQuestions: [], skills: [], mcpServers: [],
  });
}

describe('fetchBundleFromUrl / validateSourceUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('仅允许 http/https；URL 合法性校验', () => {
    expect(() => validateSourceUrl('ftp://x.com/a')).toThrow(BusinessException);
    expect(() => validateSourceUrl('not a url')).toThrow(BusinessException);
    expect(() => validateSourceUrl('')).toThrow(BusinessException);
    expect(() => validateSourceUrl(`http://x.com/${'a'.repeat(1100)}`)).toThrow(BusinessException);
    expect(validateSourceUrl('https://x.com/api/v1/agent-bundle/registry/1')).toBe('https://x.com/api/v1/agent-bundle/registry/1');
  });

  it('解析成功返回 bundle；HTTP 非 2xx / 非 JSON / 非 bundle 格式报 PARAM_INVALID', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('err500')) return httpResponse(500, null);
      if (url.includes('badjson')) return httpResponse(200, '<html>not json</html>');
      if (url.includes('notbundle')) return httpResponse(200, JSON.stringify({ hello: 1 }));
      return httpResponse(200, validBundleJson());
    });
    vi.stubGlobal('fetch', fetchMock);

    const bundle = await fetchBundleFromUrl('https://x.com/api/v1/agent-bundle/registry/1');
    expect(bundle.format).toBe(BUNDLE_FORMAT);
    await expect(fetchBundleFromUrl('https://x.com/err500')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(fetchBundleFromUrl('https://x.com/badjson')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(fetchBundleFromUrl('https://x.com/notbundle')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('超过 20MB 上限拒绝（content-length 与流式累计双口径）', async () => {
    const bigBody = JSON.stringify({ format: BUNDLE_FORMAT, pad: 'x'.repeat(BUNDLE_FETCH_MAX_BYTES + 1) });
    const fetchMock = vi.fn(async () => httpResponse(200, bigBody));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchBundleFromUrl('https://x.com/big')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    const fetchMock2 = vi.fn(async () => httpResponse(200, bigBody, { 'content-length': String(BUNDLE_FETCH_MAX_BYTES + 1) }));
    vi.stubGlobal('fetch', fetchMock2);
    await expect(fetchBundleFromUrl('https://x.com/big')).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });
});

// ---------------------------------------------------------------- service：registry 导出 / URL 导入 / 检查更新

interface Fixture {
  root: string;
  skillLoader: SkillLoader;
  userSkillService: UserSkillService;
  agentRows: Map<number, Agent>;
  originRows: Map<number, { sourceUrl: string; contentHash: string; importedSystemPrompt: string | null; importedBy: number }>;
  entryRows: Array<{ agentId: number; sourceUrl: string | null }>;
  service: AgentBundleService;
}

function buildFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mao-dist-'));
  const skillsDir = join(root, 'skills');
  const userSkillsDir = join(root, 'userskills');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(userSkillsDir, { recursive: true });
  const skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
  const userSkillService = new UserSkillService(userSkillsDir);
  const agentRows = new Map<number, Agent>();
  const agentRepo = {
    findById: async (id: number) => agentRows.get(id) ?? null,
    selectList: async () => [...agentRows.values()],
    insert: async (agent: Agent) => {
      const id = agentRows.size + 1;
      agentRows.set(id, { ...agent, id });
      return id;
    },
  };
  const originRows = new Map<number, { sourceUrl: string; contentHash: string; importedSystemPrompt: string | null; importedBy: number }>();
  const entryRows: Array<{ agentId: number; sourceUrl: string | null }> = [];
  const cipher = new McpSecretCipher('unit-test-secret');
  const service = new AgentBundleService(
    agentRepo as never,
    { listByAgentId: async () => [], syncExperiences: vi.fn() } as never,
    { listByAgentId: async () => [], syncSuggestedQuestions: vi.fn() } as never,
    skillLoader,
    userSkillService,
    { getForRuntime: async () => { throw new BusinessException(ErrorCode.PARAM_INVALID, 'MCP 服务器不存在'); }, decryptEnv: () => ({}) } as never,
    {
      countByUserIdAndName: async () => 0,
      countByNameWhereUserIdNot: async () => 0,
      insert: async () => 101,
    } as never,
    cipher,
    {
      findByAgentId: async (id: number) => originRows.get(id) ?? null,
      listAll: async () => [...originRows.entries()].map(([agentId, row]) => ({ agentId, ...row })),
      upsert: async (agentId: number, sourceUrl: string, contentHash: string, importedSystemPrompt: string | null, importedBy: number) => {
        originRows.set(agentId, { sourceUrl, contentHash, importedSystemPrompt, importedBy });
      },
    },
    { listAll: async () => entryRows.map((r) => ({ ...r })) },
  );
  return { root, skillLoader, userSkillService, agentRows, originRows, entryRows, service };
}

function putAgent(fx: Fixture, id: number, agent: Partial<Agent>): void {
  fx.agentRows.set(id, { id, name: `A${id}`, systemPrompt: 'p', enabled: 1, ...agent } as Agent);
}

describe('AgentBundleService.exportRegistryBundle（registry 内联策略）', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
  });
  afterEach(() => {
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('用户技能以 name@userId 显式 token 全量内联；系统技能保持 reference；hash 与 computeBundleContentHash 一致', async () => {
    mkdirSync(join(fx.root, 'skills', 'web-search'), { recursive: true });
    writeFileSync(join(fx.root, 'skills', 'web-search', 'SKILL.md'), '---\nname: web-search\ndescription: 系统技能\n---\n正文\n');
    await fx.userSkillService.uploadUserSkill(8, [
      { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from('---\nname: code-review\ndescription: 评审\n---\n正文\n') },
    ]);
    fx.skillLoader.invalidateCache();
    putAgent(fx, 1, { skillNames: JSON.stringify(['web-search', 'code-review']) });

    const { bundle, contentHash } = await fx.service.exportRegistryBundle(1);
    expect(bundle.skills).toEqual([
      { name: 'web-search', include: 'reference' },
      { name: 'code-review', include: 'inline', files: expect.objectContaining({ 'SKILL.md': expect.stringContaining('code-review') }) },
    ]);
    expect(contentHash).toBe(computeBundleContentHash(bundle));
  });

  it('停用 Agent → AGENT_NOT_FOUND；同名多归属技能 → PARAM_INVALID', async () => {
    await fx.userSkillService.uploadUserSkill(8, [
      { originalFilename: 'dup/SKILL.md', buffer: Buffer.from('---\nname: dup\ndescription: d\n---\n正文\n') },
    ]);
    await fx.userSkillService.uploadUserSkill(9, [
      { originalFilename: 'dup/SKILL.md', buffer: Buffer.from('---\nname: dup\ndescription: d\n---\n正文\n') },
    ]);
    fx.skillLoader.invalidateCache();
    putAgent(fx, 2, { enabled: 0 });
    await expect(fx.service.exportRegistryBundle(2)).rejects.toMatchObject({ code: ErrorCode.AGENT_NOT_FOUND.code });
    putAgent(fx, 3, { skillNames: JSON.stringify(['dup']) });
    await expect(fx.service.exportRegistryBundle(3)).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });
});

describe('AgentBundleService.importBundleFromUrl / checkUpdates', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = buildFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(fx.root, { recursive: true, force: true });
  });

  it('两段式：confirm=false 出预检回显 sourceUrl 且不落 origin；confirm=true 落库并 upsert origin（hash + systemPrompt 快照）', async () => {
    let remoteBundle = validBundleJson('v1 提示词');
    vi.stubGlobal('fetch', vi.fn(async () => httpResponse(200, remoteBundle)));

    const report = await fx.service.importBundleFromUrl('http://src.example.com/api/v1/agent-bundle/registry/9', false, 7);
    expect((report as { sourceUrl?: string }).sourceUrl).toBe('http://src.example.com/api/v1/agent-bundle/registry/9');
    expect(fx.originRows.size).toBe(0);

    const result = await fx.service.importBundleFromUrl('http://src.example.com/api/v1/agent-bundle/registry/9', true, 7) as { agentId: number };
    expect(result.agentId).toBeGreaterThan(0);
    expect(fx.originRows.get(result.agentId)).toMatchObject({
      sourceUrl: 'http://src.example.com/api/v1/agent-bundle/registry/9',
      importedSystemPrompt: 'v1 提示词',
      importedBy: 7,
    });
    expect(fx.originRows.get(result.agentId)?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    remoteBundle = validBundleJson('v2 提示词');
  });

  it('旧版/新版 bundle 导入回归：skills[].sourceUrl 字段被忽略，无该字段的旧 bundle 不受影响', async () => {
    const raw = JSON.parse(validBundleJson('提示词'));
    raw.skills = [{ name: 'some-skill', include: 'reference', sourceUrl: 'http://src.example.com/skills/some-skill' }];
    vi.stubGlobal('fetch', vi.fn(async () => httpResponse(200, JSON.stringify(raw))));
    const result = await fx.service.importBundleFromUrl('http://src.example.com/r/1', true, 7) as { agentId: number; report: { skills: Array<{ name: string }> } };
    // sourceUrl 不影响导入语义：reference 技能照常进 skillNames 并报告 missing
    expect(result.report.skills[0].name).toBe('some-skill');
    const agent = fx.agentRows.get(result.agentId);
    expect(JSON.parse(agent!.skillNames!)).toEqual(['some-skill']);
  });

  it('checkUpdates：未变更 changed=false；远端变更 changed=true；systemPrompt 漂移 localEdited=true', async () => {
    let remoteBundle = validBundleJson('v1 提示词');
    vi.stubGlobal('fetch', vi.fn(async () => httpResponse(200, remoteBundle)));
    const { agentId } = await fx.service.importBundleFromUrl('http://src.example.com/r/1', true, 7) as { agentId: number };

    let items = await fx.service.checkUpdates(null);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ agentId, changed: false, localEdited: false, originHash: items[0].originHash, remoteHash: items[0].originHash });

    remoteBundle = validBundleJson('v2 提示词');
    items = await fx.service.checkUpdates(null);
    expect(items[0]).toMatchObject({ agentId, changed: true, localEdited: false });

    // 本地提示词被改：changed 仍 true（远端未回到基线），localEdited = true
    putAgent(fx, agentId, { systemPrompt: '本地改过的提示词' });
    items = await fx.service.checkUpdates([agentId]);
    expect(items[0]).toMatchObject({ agentId, changed: true, localEdited: true });

    // 远端回到基线但本地已漂移：changed=false、localEdited=true
    remoteBundle = validBundleJson('v1 提示词');
    items = await fx.service.checkUpdates(null);
    expect(items[0]).toMatchObject({ changed: false, localEdited: true });
  });

  it('双 URL 取舍：条目 source_url 优先于 origin；单项失败不阻断其余项；无来源显式项报 error', async () => {
    let remoteBundle = validBundleJson('v1 提示词');
    const seenUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      seenUrls.push(String(input));
      if (String(input).includes('broken')) return httpResponse(500, null);
      return httpResponse(200, remoteBundle);
    }));
    const a = await fx.service.importBundleFromUrl('http://src-a.example.com/r/1', true, 7) as { agentId: number };
    const b = await fx.service.importBundleFromUrl('http://src-b.example.com/r/2', true, 7) as { agentId: number };

    // 条目 URL（管理员维护）优先于 origin
    fx.entryRows.push({ agentId: a.agentId, sourceUrl: 'http://entry.example.com/r/1' });
    // b 指向 broken：单项失败不阻断
    fx.entryRows.push({ agentId: b.agentId, sourceUrl: 'http://broken.example.com/r/2' });
    // 无来源显式项
    putAgent(fx, 99, {});

    const items = await fx.service.checkUpdates(null);
    const itemA = items.find((i) => i.agentId === a.agentId)!;
    const itemB = items.find((i) => i.agentId === b.agentId)!;
    expect(itemA.sourceUrl).toBe('http://entry.example.com/r/1');
    expect(seenUrls).toContain('http://entry.example.com/r/1');
    expect(itemB.error).toContain('500');
    expect(itemA.error).toBeUndefined();

    const items2 = await fx.service.checkUpdates([99]);
    expect(items2).toHaveLength(1);
    expect(items2[0].agentId).toBe(99);
    expect(items2[0].error).toContain('无导入来源');
  });
});

// ---------------------------------------------------------------- 路由：registry 免登录端点

describe('registry 只读端点（开关/token/错误映射）', () => {
  function appWithRegistry(options: { enabled: boolean; accessToken?: string | null; exportImpl?: () => Promise<unknown> }) {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    const exportRegistryBundle = options.exportImpl
      ?? vi.fn(async () => ({ bundle: JSON.parse(validBundleJson()), contentHash: 'a'.repeat(64) }));
    registerAgentBundleRoutes(fastify, {
      agentBundleService: { exportRegistryBundle } as never,
      permissionService: { hasPermission: vi.fn(async () => true) },
      registryConfig: { getBundleRegistryConfig: async () => ({ enabled: options.enabled, accessToken: options.accessToken ?? null }) },
    });
    return { fastify, exportRegistryBundle };
  }

  it('开关关闭 → 404（含未登录请求）；未登录在开启时可拉取 bundle + hash header', async () => {
    const closed = appWithRegistry({ enabled: false });
    try {
      const res = await closed.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1' });
      expect(res.statusCode).toBe(404);
      expect(closed.exportRegistryBundle).not.toHaveBeenCalled();
    } finally {
      await closed.fastify.close();
    }

    const open = appWithRegistry({ enabled: true });
    try {
      const res = await open.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-mao-content-hash']).toBe('a'.repeat(64));
      expect(res.json()).toMatchObject({ format: BUNDLE_FORMAT });
    } finally {
      await open.fastify.close();
    }
  });

  it('token 校验：错误 token 404；query token / header token 正确时放行', async () => {
    const fixture = appWithRegistry({ enabled: true, accessToken: 's3cret-token' });
    try {
      expect((await fixture.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1' })).statusCode).toBe(404);
      expect((await fixture.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1?token=wrong' })).statusCode).toBe(404);
      expect((await fixture.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1?token=s3cret-token' })).statusCode).toBe(200);
      expect((await fixture.fastify.inject({
        method: 'GET', url: '/v1/agent-bundle/registry/1', headers: { 'x-mao-registry-token': 's3cret-token' },
      })).statusCode).toBe(200);
    } finally {
      await fixture.fastify.close();
    }
  });

  it('Agent 不存在/停用 → 404；导出失败 → 409 结构化错误（非 Result 信封）', async () => {
    const fixture = appWithRegistry({
      enabled: true,
      exportImpl: vi.fn(async () => { throw new BusinessException(ErrorCode.AGENT_NOT_FOUND); }),
    });
    try {
      expect((await fixture.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1' })).statusCode).toBe(404);
    } finally {
      await fixture.fastify.close();
    }

    const conflict = appWithRegistry({
      enabled: true,
      exportImpl: vi.fn(async () => { throw new BusinessException(ErrorCode.PARAM_INVALID, '技能「dup」存在多个归属'); }),
    });
    try {
      const res = await conflict.fastify.inject({ method: 'GET', url: '/v1/agent-bundle/registry/2' });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: 'bundle 导出失败', detail: [expect.stringContaining('多个归属')] });
      expect(res.json().code).toBeUndefined();
    } finally {
      await conflict.fastify.close();
    }
  });

  it('URL 导入/检查更新端点要求 agent:write', async () => {
    const fastify = Fastify();
    fastify.setErrorHandler(handleError);
    fastify.addHook('preHandler', (req, _r, done) => {
      (req as { userId?: number }).userId = 7;
      done();
    });
    let allowed = false;
    registerAgentBundleRoutes(fastify, {
      agentBundleService: {
        importBundleFromUrl: vi.fn(async () => (allowed ? { agentName: 'A' } : { agentName: 'A' })),
        checkUpdates: vi.fn(async () => []),
      } as never,
      permissionService: { hasPermission: vi.fn(async () => allowed) },
      registryConfig: { getBundleRegistryConfig: async () => ({ enabled: false, accessToken: null }) },
    });
    try {
      expect((await fastify.inject({ method: 'POST', url: '/v1/agent-bundle/import-from-url', payload: { url: 'http://x/r/1' } })).statusCode).toBe(403);
      expect((await fastify.inject({ method: 'POST', url: '/v1/agent-bundle/check-updates', payload: {} })).statusCode).toBe(403);
      allowed = true;
      const ok = await fastify.inject({ method: 'POST', url: '/v1/agent-bundle/check-updates', payload: { agentIds: [1, 'x', -2] } });
      expect(ok.statusCode).toBe(200);
    } finally {
      await fastify.close();
    }
  });
});
