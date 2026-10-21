import { describe, expect, it, vi } from 'vitest';
import { HttpToolService } from './http-tool.service.js';
import { HttpToolHeaderCipher } from './http-tool-cipher.js';
import { ErrorCode } from '../common/error-code.js';
import type {
  HttpTool, HttpToolParam, HttpToolRepository,
} from './types.js';

/** 内存版 repository：全局唯一 name，事务即顺序执行（回滚语义不在单测范围）。 */
function fakeRepo(seed: HttpTool[] = []): HttpToolRepository & { tools: HttpTool[]; params: HttpToolParam[] } {
  const tools = [...seed];
  const params: HttpToolParam[] = [];
  let nextId = 100;
  const nextParamId = 200;
  return {
    tools,
    params,
    async listEnabledByIds(ids) {
      return tools
        .filter((t) => t.enabled === 1 && t.id != null && ids.includes(t.id))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async findById(id) { return tools.find((t) => t.id === id) ?? null; },
    async findByName(name) { return tools.find((t) => t.name === name) ?? null; },
    async listParamsByToolId(toolId) { return params.filter((p) => p.toolId === toolId).sort((a, b) => a.sortOrder - b.sortOrder); },
    async insert(tool) { tool.id = nextId++; tools.push(tool); return tool.id!; },
    async updateById(tool) {
      const index = tools.findIndex((t) => t.id === tool.id);
      if (index >= 0) tools[index] = tool;
    },
    async deleteById(id) {
      const index = tools.findIndex((t) => t.id === id);
      if (index >= 0) tools.splice(index, 1);
      for (let i = params.length - 1; i >= 0; i--) {
        if (params[i]!.toolId === id) params.splice(i, 1);
      }
    },
    async insertParam(param) { param.id = nextParamId + params.length; params.push(param); return param.id!; },
    async deleteParamsByToolId(toolId) {
      for (let i = params.length - 1; i >= 0; i--) {
        if (params[i]!.toolId === toolId) params.splice(i, 1);
      }
    },
    async transaction(fn) { return fn(this); },
    async listForAdmin(page, size, query) {
      let rows = [...tools];
      if (query.keyword) {
        const kw = query.keyword;
        rows = rows.filter((t) => t.name.includes(kw) || t.displayName.includes(kw));
      }
      if (query.enabled != null) {
        rows = rows.filter((t) => (t.enabled === 1) === query.enabled);
      }
      const total = rows.length;
      return { rows: rows.slice((page - 1) * size, page * size), total };
    },
    async listEnabledBrief() {
      return tools
        .filter((t) => t.enabled === 1)
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((t) => ({ id: t.id!, name: t.name, displayName: t.displayName, method: t.method, readOnly: t.readOnly }));
    },
  };
}

function seedTool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    id: 1,
    name: 'weather',
    displayName: '天气查询',
    description: '查询城市天气',
    method: 'GET',
    url: 'https://api.example.com/v1/weather',
    headersJson: null,
    bodyTemplate: null,
    readOnly: 1,
    timeoutMs: 15000,
    enabled: 1,
    createdAt: '2026-10-20 10:00:00',
    updatedAt: '2026-10-20 10:00:00',
    ...overrides,
  };
}

function makeService(options: { repo?: HttpToolRepository; builtins?: string[] } = {}) {
  const repo = options.repo ?? fakeRepo();
  const service = new HttpToolService({
    repo,
    cipher: new HttpToolHeaderCipher('unit-test-secret'),
    builtinToolNames: () => options.builtins ?? ['read_file', 'shell'],
  });
  return { repo, service };
}

const draft = {
  name: 'weather',
  displayName: '天气查询',
  description: '查询城市天气',
  method: 'GET',
  url: 'https://api.example.com/v1/weather',
  params: [{ name: 'city', label: '城市', type: 'string', required: true }],
};

describe('HttpToolService create', () => {
  it('creates a tool with inferred read_only and normalized params', async () => {
    const { service } = makeService();
    const vo = await service.create(draft);
    expect(vo).toMatchObject({ name: 'weather', readOnly: true, enabled: true, timeoutMs: 15000 });
    expect(vo.params).toHaveLength(1);
    expect(vo.params[0]).toMatchObject({ name: 'city', required: true, sortOrder: 0 });
  });

  it('infers read_only=false for write methods', async () => {
    const { service } = makeService();
    const vo = await service.create({ ...draft, name: 'create_order', method: 'POST' });
    expect(vo.readOnly).toBe(false);
  });

  it('rejects duplicate names, reserved names and invalid slugs', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    await expect(service.create(draft)).rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NAME_DUPLICATE.code });
    for (const name of ['http_call', 'http_describe', 'mcp__x', 'read_file']) {
      await expect(service.create({ ...draft, name }), name)
        .rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NAME_RESERVED.code });
    }
    for (const name of ['Weather', '1abc', 'ab-cd', '']) {
      await expect(service.create({ ...draft, name }), name)
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    }
  });

  it('rejects unsupported methods, protocols and oversized fields', async () => {
    const { service } = makeService();
    await expect(service.create({ ...draft, method: 'OPTIONS' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({ ...draft, url: 'ftp://x.example.com' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({ ...draft, url: 'not-a-url' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({ ...draft, displayName: '' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({ ...draft, description: 'x'.repeat(1001) })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({
      ...draft,
      headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`H${i}`, 'v'])),
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create({
      ...draft,
      params: Array.from({ length: 51 }, (_, i) => ({ name: `p${i}`, label: 'P' })),
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('encrypts sensitive headers and masks them on echo', async () => {
    const { service, repo } = makeService();
    const vo = await service.create({
      ...draft,
      headers: { Authorization: 'Bearer secret', 'X-Trace': 'abc' },
    });
    expect(vo.headers).toEqual([
      { key: 'Authorization', value: '******', sensitive: true },
      { key: 'X-Trace', value: 'abc', sensitive: false },
    ]);
    const stored = repo.tools[0]!.headersJson!;
    expect(stored).not.toContain('secret');
    expect(stored).toContain('enc:');
  });
});

describe('HttpToolService update', () => {
  it('rejects unknown tool ids', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    await expect(service.update(99, draft)).rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NOT_FOUND.code });
  });

  it('reuses the stored ciphertext when the header value is the mask sentinel', async () => {
    const { service, repo } = makeService({ repo: fakeRepo([seedTool()]) });
    const created = await service.create({ ...draft, name: 'orders', headers: { Authorization: 'Bearer secret' } });
    const storedBefore = repo.tools.find((t) => t.name === 'orders')!.headersJson!;
    const updated = await service.update(created.id!, {
      ...draft, name: 'orders', headers: { Authorization: '******' },
    });
    expect(updated.headers).toEqual([{ key: 'Authorization', value: '******', sensitive: true }]);
    expect(repo.tools.find((t) => t.name === 'orders')!.headersJson).toBe(storedBefore);
  });

  it('replaces a sensitive header with a new value and clears it with an empty value', async () => {
    const { service, repo } = makeService();
    const created = await service.create({ ...draft, name: 'orders', headers: { Authorization: 'Bearer old' } });
    await service.update(created.id!, { ...draft, name: 'orders', headers: { Authorization: 'Bearer new' } });
    const row = repo.tools.find((t) => t.name === 'orders')!;
    const cipher = new HttpToolHeaderCipher('unit-test-secret');
    const storedHeaders = JSON.parse(row.headersJson!) as Record<string, string>;
    expect(cipher.decrypt(storedHeaders['Authorization']!.slice('enc:'.length))).toBe('Bearer new');
    await service.update(created.id!, { ...draft, name: 'orders', headers: { Authorization: '' } });
    expect(repo.tools.find((t) => t.name === 'orders')!.headersJson).toBeNull();
  });

  it('checks name-change uniqueness only against the new name', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders' })]) });
    await expect(service.update(1, { ...draft, name: 'orders' }))
      .rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NAME_DUPLICATE.code });
    const vo = await service.update(1, draft);
    expect(vo.name).toBe('weather');
  });

  it('keeps the stored enabled state when the draft omits enabled', async () => {
    // 编辑是全量替换，但省略 enabled 不得把停用的工具静默改回启用。
    const { service, repo } = makeService({
      repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders', enabled: 0 })]),
    });
    const vo = await service.update(2, { ...draft, name: 'orders' });
    expect(vo.enabled).toBe(false);
    expect(repo.tools.find((t) => t.id === 2)!.enabled).toBe(0);
  });
});

describe('HttpToolService remove / setEnabled', () => {
  it('deletes the tool together with its params', async () => {
    const { service, repo } = makeService();
    const created = await service.create(draft);
    await expect(service.remove(99)).rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NOT_FOUND.code });
    expect(repo.tools).toHaveLength(1);
    await service.remove(created.id!);
    expect(repo.tools).toHaveLength(0);
    expect(repo.params).toHaveLength(0);
  });

  it('toggles enabled state', async () => {
    const { service } = makeService({
      repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders', enabled: 0 })]),
    });
    const disabled = await service.setEnabled(1, false);
    expect(disabled.enabled).toBe(false);
    const reEnabled = await service.setEnabled(1, true);
    expect(reEnabled.enabled).toBe(true);
    await expect(service.setEnabled(99, true)).rejects.toMatchObject({ code: ErrorCode.HTTP_TOOL_NOT_FOUND.code });
  });
});

describe('HttpToolService execution resolution', () => {
  it('returns [] without touching the repo when the agent has no association', async () => {
    const repo = fakeRepo();
    const { service } = makeService({ repo });
    await expect(service.listEnabledForAgent({ httpToolIds: null })).resolves.toEqual([]);
    await expect(service.listEnabledForAgent({})).resolves.toEqual([]);
    await expect(service.listEnabledForAgent({ httpToolIds: 'not-json' })).resolves.toEqual([]);
    expect(repo.tools).toHaveLength(0);
  });

  it('lists enabled tools of the agent by name ASC, skipping disabled and unassociated ones', async () => {
    const { service } = makeService({
      repo: fakeRepo([
        seedTool({ id: 2, name: 'orders', enabled: 0 }),
        seedTool({ id: 3, name: 'alerts', enabled: 1 }),
        seedTool({ id: 4, name: 'other', enabled: 1 }),
      ]),
    });
    const list = await service.listEnabledForAgent({ httpToolIds: JSON.stringify([2, 3]) });
    expect(list.map((t) => t.name)).toEqual(['alerts']);
  });

  it('resolves only associated enabled tools and decrypts headers', async () => {
    const { service } = makeService();
    const created = await service.create({ ...draft, headers: { Authorization: 'Bearer secret' } });
    const agent = { httpToolIds: JSON.stringify([created.id!]) };
    const resolved = await service.resolveForExecution(agent, 'weather');
    expect(resolved?.tool.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(resolved?.params).toHaveLength(1);
    await expect(service.resolveForExecution({ httpToolIds: null }, 'weather')).resolves.toBeNull();
    await service.setEnabled(created.id!, false);
    await expect(service.resolveForExecution(agent, 'weather')).resolves.toBeNull();
  });

  it('fails closed when a stored header cannot be decrypted', async () => {
    const repo = fakeRepo([seedTool({ headersJson: JSON.stringify({ Authorization: 'enc:garbage' }) })]);
    const { service } = makeService({ repo });
    await expect(service.resolveForExecution({ httpToolIds: JSON.stringify([1]) }, 'weather')).rejects.toThrow();
  });

  it('describes enabled tools with params', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    const agent = { httpToolIds: JSON.stringify([1]) };
    const found = await service.findEnabledWithParams(agent, 'weather');
    expect(found?.tool.name).toBe('weather');
    await expect(service.findEnabledWithParams(agent, 'nope')).resolves.toBeNull();
  });

  it('validates test drafts and rejects mask sentinel header values', async () => {
    const { service } = makeService();
    const resolved = service.resolveDraftForExecution({ ...draft, name: 'draft_tool' });
    expect(resolved.tool).toMatchObject({ name: 'draft_tool', method: 'GET' });
    expect(() => service.resolveDraftForExecution({ ...draft, headers: { Authorization: '******' } }))
      .toThrow();
    expect(() => service.resolveDraftForExecution({ ...draft, url: 'ftp://x' })).toThrow();
  });
});

describe('HttpToolService admin list', () => {
  it('returns full VOs with masked headers and params for the edit form', async () => {
    const { service } = makeService();
    await service.create({ ...draft, headers: { Authorization: 'Bearer secret', 'X-Trace': 'on' } });
    const { records, total } = await service.listForAdmin(1, 20, {});
    expect(total).toBe(1);
    expect(records[0]).toMatchObject({ name: 'weather', displayName: '天气查询', readOnly: true, enabled: true });
    // 敏感头打码、非敏感头明文：编辑表单回填后「掩码 = 不修改」
    expect(records[0]!.headers).toEqual([
      { key: 'Authorization', value: '******', sensitive: true },
      { key: 'X-Trace', value: 'on', sensitive: false },
    ]);
    expect(records[0]!.params).toEqual([
      { id: 200, name: 'city', label: '城市', type: 'string', required: true, defaultValue: null, sortOrder: 0 },
    ]);
  });

  it('filters by keyword and enabled state', async () => {
    const { service } = makeService();
    await service.create(draft);
    await service.create({ ...draft, name: 'orders', displayName: '下单', enabled: false });
    const all = await service.listForAdmin(1, 20, {});
    expect(all.total).toBe(2);
    const byKeyword = await service.listForAdmin(1, 20, { keyword: 'weather' });
    expect(byKeyword.records.map((r) => r.name)).toEqual(['weather']);
    const enabledOnly = await service.listForAdmin(1, 20, { enabled: true });
    expect(enabledOnly.records.map((r) => r.name)).toEqual(['weather']);
  });

  it('lists enabled tools briefly for the agent form dropdown', async () => {
    const { service } = makeService();
    await service.create(draft);
    await service.create({ ...draft, name: 'orders', displayName: '下单', enabled: false });
    const brief = await service.listEnabledBrief();
    expect(brief).toEqual([
      { id: expect.any(Number), name: 'weather', displayName: '天气查询', method: 'GET', readOnly: 1 },
    ]);
  });
});
