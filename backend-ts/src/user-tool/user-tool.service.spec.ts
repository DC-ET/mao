import { describe, expect, it, vi } from 'vitest';
import { UserToolService } from './user-tool.service.js';
import { UserToolHeaderCipher } from './user-tool-cipher.js';
import { ErrorCode } from '../common/error-code.js';
import type {
  UserTool, UserToolParam, UserToolRepository,
} from './types.js';

/** 内存版 repository：按 userId 隔离，事务即顺序执行（回滚语义不在单测范围）。 */
function fakeRepo(seed: UserTool[] = []): UserToolRepository & { tools: UserTool[]; params: UserToolParam[] } {
  const tools = [...seed];
  const params: UserToolParam[] = [];
  let nextId = 100;
  const nextParamId = 200;
  return {
    tools,
    params,
    async listByUserId(userId) {
      return tools.filter((t) => t.userId === userId).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async listEnabledByUserId(userId) {
      return tools.filter((t) => t.userId === userId && t.enabled === 1).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async findById(id) { return tools.find((t) => t.id === id) ?? null; },
    async findByIdAndUserId(id, userId) { return tools.find((t) => t.id === id && t.userId === userId) ?? null; },
    async findByUserIdAndName(userId, name) { return tools.find((t) => t.userId === userId && t.name === name) ?? null; },
    async countEnabledByUserId(userId) { return tools.filter((t) => t.userId === userId && t.enabled === 1).length; },
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
  };
}

function seedTool(overrides: Partial<UserTool> = {}): UserTool {
  return {
    id: 1,
    userId: 9,
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

function makeService(options: { repo?: UserToolRepository; maxEnabled?: number; builtins?: string[] } = {}) {
  const repo = options.repo ?? fakeRepo();
  const settings = { getMaxEnabledPerUser: vi.fn(async () => options.maxEnabled ?? 20) };
  const service = new UserToolService({
    repo,
    cipher: new UserToolHeaderCipher('unit-test-secret'),
    settings,
    builtinToolNames: () => options.builtins ?? ['read_file', 'shell'],
  });
  return { repo, settings, service };
}

const draft = {
  name: 'weather',
  displayName: '天气查询',
  description: '查询城市天气',
  method: 'GET',
  url: 'https://api.example.com/v1/weather',
  params: [{ name: 'city', label: '城市', type: 'string', required: true }],
};

describe('UserToolService create', () => {
  it('creates a tool with inferred read_only and normalized params', async () => {
    const { service } = makeService();
    const vo = await service.create(9, draft);
    expect(vo).toMatchObject({ name: 'weather', readOnly: true, enabled: true, timeoutMs: 15000 });
    expect(vo.params).toHaveLength(1);
    expect(vo.params[0]).toMatchObject({ name: 'city', required: true, sortOrder: 0 });
  });

  it('infers read_only=false for write methods', async () => {
    const { service } = makeService();
    const vo = await service.create(9, { ...draft, name: 'create_order', method: 'POST' });
    expect(vo.readOnly).toBe(false);
  });

  it('rejects duplicate names, reserved names and invalid slugs', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    await expect(service.create(9, draft)).rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NAME_DUPLICATE.code });
    for (const name of ['http_call', 'http_describe', 'mcp__x', 'read_file']) {
      await expect(service.create(9, { ...draft, name }), name)
        .rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NAME_RESERVED.code });
    }
    for (const name of ['Weather', '1abc', 'ab-cd', '']) {
      await expect(service.create(9, { ...draft, name }), name)
        .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    }
  });

  it('rejects unsupported methods, protocols and oversized fields', async () => {
    const { service } = makeService();
    await expect(service.create(9, { ...draft, method: 'OPTIONS' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, { ...draft, url: 'ftp://x.example.com' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, { ...draft, url: 'not-a-url' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, { ...draft, displayName: '' })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, { ...draft, description: 'x'.repeat(1001) })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, {
      ...draft,
      headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`H${i}`, 'v'])),
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    await expect(service.create(9, {
      ...draft,
      params: Array.from({ length: 51 }, (_, i) => ({ name: `p${i}`, label: 'P' })),
    })).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('enforces the per-user enabled limit only when enabling', async () => {
    const { service } = makeService({ maxEnabled: 1, repo: fakeRepo([seedTool()]) });
    await expect(service.create(9, { ...draft, name: 'other' }))
      .rejects.toMatchObject({ code: ErrorCode.USER_TOOL_ENABLED_LIMIT_EXCEEDED.code });
    const vo = await service.create(9, { ...draft, name: 'other', enabled: false });
    expect(vo.enabled).toBe(false);
  });

  it('encrypts sensitive headers and masks them on echo', async () => {
    const { service, repo } = makeService();
    const vo = await service.create(9, {
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

describe('UserToolService update', () => {
  it('rejects tools owned by another user', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    await expect(service.update(10, 1, draft)).rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NOT_FOUND.code });
  });

  it('reuses the stored ciphertext when the header value is the mask sentinel', async () => {
    const { service, repo } = makeService({ repo: fakeRepo([seedTool()]) });
    const created = await service.create(9, { ...draft, name: 'orders', headers: { Authorization: 'Bearer secret' } });
    const storedBefore = repo.tools.find((t) => t.name === 'orders')!.headersJson!;
    const updated = await service.update(9, created.id!, {
      ...draft, name: 'orders', headers: { Authorization: '******' },
    });
    expect(updated.headers).toEqual([{ key: 'Authorization', value: '******', sensitive: true }]);
    expect(repo.tools.find((t) => t.name === 'orders')!.headersJson).toBe(storedBefore);
  });

  it('replaces a sensitive header with a new value and clears it with an empty value', async () => {
    const { service, repo } = makeService();
    const created = await service.create(9, { ...draft, name: 'orders', headers: { Authorization: 'Bearer old' } });
    await service.update(9, created.id!, { ...draft, name: 'orders', headers: { Authorization: 'Bearer new' } });
    const row = repo.tools.find((t) => t.name === 'orders')!;
    const cipher = new UserToolHeaderCipher('unit-test-secret');
    const storedHeaders = JSON.parse(row.headersJson!) as Record<string, string>;
    expect(cipher.decrypt(storedHeaders['Authorization']!.slice('enc:'.length))).toBe('Bearer new');
    await service.update(9, created.id!, { ...draft, name: 'orders', headers: { Authorization: '' } });
    expect(repo.tools.find((t) => t.name === 'orders')!.headersJson).toBeNull();
  });

  it('checks name-change uniqueness only against the new name', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders' })]) });
    await expect(service.update(9, 1, { ...draft, name: 'orders' }))
      .rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NAME_DUPLICATE.code });
    const vo = await service.update(9, 1, draft);
    expect(vo.name).toBe('weather');
  });

  it('keeps the stored enabled state when the draft omits enabled', async () => {
    // 编辑是全量替换，但省略 enabled 不得把用户停用的工具静默改回启用；
    // 启用数已满时也不能因此阻断「只想改个 URL」的编辑。
    const { service, repo } = makeService({
      maxEnabled: 1,
      repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders', enabled: 0 })]),
    });
    const vo = await service.update(9, 2, { ...draft, name: 'orders' });
    expect(vo.enabled).toBe(false);
    expect(repo.tools.find((t) => t.id === 2)!.enabled).toBe(0);
    await expect(service.update(9, 2, { ...draft, name: 'orders', enabled: true }))
      .rejects.toMatchObject({ code: ErrorCode.USER_TOOL_ENABLED_LIMIT_EXCEEDED.code });
  });
});

describe('UserToolService remove / setEnabled', () => {
  it('deletes the tool together with its params (owner-scoped)', async () => {
    const { service, repo } = makeService();
    const created = await service.create(9, draft);
    await expect(service.remove(10, created.id!)).rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NOT_FOUND.code });
    expect(repo.tools).toHaveLength(1);
    await service.remove(9, created.id!);
    expect(repo.tools).toHaveLength(0);
    expect(repo.params).toHaveLength(0);
  });

  it('toggles enabled state and enforces the cap on enable', async () => {
    const { service } = makeService({
      maxEnabled: 1,
      repo: fakeRepo([seedTool(), seedTool({ id: 2, name: 'orders', enabled: 0 })]),
    });
    await expect(service.setEnabled(9, 2, true))
      .rejects.toMatchObject({ code: ErrorCode.USER_TOOL_ENABLED_LIMIT_EXCEEDED.code });
    const disabled = await service.setEnabled(9, 1, false);
    expect(disabled.enabled).toBe(false);
    const reEnabled = await service.setEnabled(9, 1, true);
    expect(reEnabled.enabled).toBe(true);
    await expect(service.setEnabled(9, 99, true)).rejects.toMatchObject({ code: ErrorCode.USER_TOOL_NOT_FOUND.code });
  });
});

describe('UserToolService execution resolution', () => {
  it('returns [] without touching the repo when the session has no owner', async () => {
    const repo = fakeRepo();
    const { service } = makeService({ repo });
    await expect(service.listEnabled(null)).resolves.toEqual([]);
    expect(repo.tools).toHaveLength(0);
  });

  it('lists enabled tools by name ASC, skipping disabled ones', async () => {
    const { service } = makeService({
      repo: fakeRepo([
        seedTool({ id: 2, name: 'orders', enabled: 0 }),
        seedTool({ id: 3, name: 'alerts', enabled: 1 }),
      ]),
    });
    const list = await service.listEnabled(9);
    expect(list.map((t) => t.name)).toEqual(['alerts']);
  });

  it('resolves only enabled tools of the owner and decrypts headers', async () => {
    const { service } = makeService();
    const created = await service.create(9, { ...draft, headers: { Authorization: 'Bearer secret' } });
    const resolved = await service.resolveForExecution(9, 'weather');
    expect(resolved?.tool.headers).toEqual({ Authorization: 'Bearer secret' });
    expect(resolved?.params).toHaveLength(1);
    await expect(service.resolveForExecution(10, 'weather')).resolves.toBeNull();
    await service.setEnabled(9, created.id!, false);
    await expect(service.resolveForExecution(9, 'weather')).resolves.toBeNull();
  });

  it('fails closed when a stored header cannot be decrypted', async () => {
    const repo = fakeRepo([seedTool({ headersJson: JSON.stringify({ Authorization: 'enc:garbage' }) })]);
    const { service } = makeService({ repo });
    await expect(service.resolveForExecution(9, 'weather')).rejects.toThrow();
  });

  it('describes enabled tools with params', async () => {
    const { service } = makeService({ repo: fakeRepo([seedTool()]) });
    const found = await service.findEnabledWithParams(9, 'weather');
    expect(found?.tool.name).toBe('weather');
    await expect(service.findEnabledWithParams(9, 'nope')).resolves.toBeNull();
  });

  it('hides tools beyond the enabled cap from both http_call and http_describe', async () => {
    // 可调用集合与目录同源同序：目录只展示前 N 个，超出的一律不可调用 / 不可描述，
    // 否则管理员下调上限后模型仍能调到被隐藏的工具（设计 §5.4）。
    const { service } = makeService({
      maxEnabled: 1,
      repo: fakeRepo([
        seedTool({ id: 2, name: 'orders' }),
        seedTool({ id: 3, name: 'alerts' }),
      ]),
    });
    await expect(service.resolveForExecution(9, 'alerts')).resolves.not.toBeNull();
    await expect(service.resolveForExecution(9, 'orders')).resolves.toBeNull();
    await expect(service.findEnabledWithParams(9, 'orders')).resolves.toBeNull();
    await expect(service.findEnabledWithParams(9, 'alerts')).resolves.not.toBeNull();
  });

  it('keeps the callable set aligned with the catalog when SQL collation order differs from JS order', async () => {
    // MySQL utf8mb4_0900_ai_ci 把 `_` 排在数字之前（weather_v1 < weather2），
    // JS code-unit 序相反（weather2 < weather_v1）。可调用名次必须与目录同一
    // 比较器重排，否则目录里看得见的 weather2 调不动、目录外的 weather_v1 反而调得通。
    const repo = fakeRepo([
      seedTool({ id: 2, name: 'weather_v1' }),
      seedTool({ id: 3, name: 'weather2' }),
    ]);
    // 模拟真实 SQL 返回序（utf8mb4_0900_ai_ci：`_` 排在数字之前）
    const sqlOrdered = {
      ...repo,
      async listEnabledByUserId() {
        return [
          repo.tools.find((t) => t.name === 'weather_v1')!,
          repo.tools.find((t) => t.name === 'weather2')!,
        ];
      },
    };
    const { service } = makeService({ maxEnabled: 1, repo: sqlOrdered as unknown as UserToolRepository });
    await expect(service.resolveForExecution(9, 'weather2')).resolves.not.toBeNull();
    await expect(service.resolveForExecution(9, 'weather_v1')).resolves.toBeNull();
    await expect(service.findEnabledWithParams(9, 'weather_v1')).resolves.toBeNull();
  });

  it('validates test drafts and rejects mask sentinel header values', async () => {
    const { service } = makeService();
    const resolved = service.resolveDraftForExecution({ ...draft, name: 'draft_tool' });
    expect(resolved.tool).toMatchObject({ name: 'draft_tool', method: 'GET' });
    expect(() => service.resolveDraftForExecution({ ...draft, headers: { Authorization: '******' } }))
      .toThrow();
    expect(() => service.resolveDraftForExecution({ ...draft, url: 'ftp://x' })).toThrow();
  });

  it('falls back to the default cap when the settings read fails', async () => {
    const repo = fakeRepo();
    const service = new UserToolService({
      repo,
      cipher: new UserToolHeaderCipher('unit-test-secret'),
      settings: { getMaxEnabledPerUser: vi.fn(async () => { throw new Error('down'); }) },
      builtinToolNames: () => [],
    });
    await expect(service.getMaxEnabledPerUser()).resolves.toBe(20);
  });
});
