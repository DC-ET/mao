/**
 * 回归用例（BUG-H1 / BUG-H2 已修复）：自定义 HTTP 工具 / 请求头编解码。
 *
 * BUG-H1：decodeHeaders 曾按「值以 enc: 开头」判断是否解密，而不是按「键是否敏感」
 *        （isSensitiveHeaderKey）。非敏感头原样落库，若其值恰好以 `enc:` 开头，
 *        执行期会被送进 cipher.decrypt() → 解密失败 → 该工具永久不可用，
 *        且用户提示的「重新保存请求头」无法修复（值仍是明文 `enc:...`）。
 *        修复：解码与编码用同一个谓词（键是否敏感）。
 *
 * BUG-H2：掩码哨兵 `******` 曾只在 isSensitiveHeaderKey 分支被识别。把敏感头改名为
 *        非敏感键时，表单带回来的掩码被当作真实值原样落库，旧密文被销毁，
 *        运行时把字面量 `******` 当凭据发出去。
 *        修复：掩码按「值」语义处理并优先判定；解析不到旧值时拒绝保存并提示重填。
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
import { HttpToolService } from './http-tool.service.js';
import { HttpToolHeaderCipher } from './http-tool-cipher.js';
import type { HttpTool, HttpToolParam, HttpToolRepository } from './types.js';

function fakeRepo(seed: HttpTool[] = []): HttpToolRepository & { tools: HttpTool[]; params: HttpToolParam[] } {
  const tools = [...seed];
  const params: HttpToolParam[] = [];
  let nextId = 100;
  const nextParamId = 200;
  return {
    tools,
    params,
    async listEnabledByIds(ids) {
      return tools.filter((t) => t.enabled === 1 && t.id != null && ids.includes(t.id));
    },
    async findById(id) { return tools.find((t) => t.id === id) ?? null; },
    async findByName(name) { return tools.find((t) => t.name === name) ?? null; },
    async listParamsByToolId(toolId) { return params.filter((p) => p.toolId === toolId); },
    async insert(tool) { tool.id = nextId++; tools.push(tool); return tool.id!; },
    async updateById(tool) {
      const index = tools.findIndex((t) => t.id === tool.id);
      if (index >= 0) tools[index] = tool;
    },
    async deleteById(id) {
      const index = tools.findIndex((t) => t.id === id);
      if (index >= 0) tools.splice(index, 1);
    },
    async insertParam(param) { param.id = nextParamId + params.length; params.push(param); return param.id!; },
    async deleteParamsByToolId(toolId) {
      for (let i = params.length - 1; i >= 0; i--) {
        if (params[i]!.toolId === toolId) params.splice(i, 1);
      }
    },
    async transaction(fn) { return fn(this); },
    async listForAdmin(page, size) {
      const rows = [...tools];
      return { rows: rows.slice((page - 1) * size, page * size), total: rows.length };
    },
    async listEnabledBrief() { return []; },
  };
}

function makeService(repo: HttpToolRepository) {
  return new HttpToolService({
    repo,
    cipher: new HttpToolHeaderCipher('unit-test-secret'),
    builtinToolNames: () => ['read_file', 'shell'],
  });
}

const baseDraft = {
  name: 'weather',
  displayName: '天气查询',
  description: '查询城市天气',
  method: 'GET',
  url: 'https://api.example.com/v1/weather',
  params: [{ name: 'city', label: '城市', type: 'string', required: true }],
};

describe('BUG-H1 非敏感请求头值以 enc: 开头时被执行期误解密（工具永久不可用）', () => {
  it('非敏感头不以 enc: 开头时执行期正常解密/透传', async () => {
    const repo = fakeRepo();
    const service = makeService(repo);
    await service.create({ ...baseDraft, headers: { 'X-Trace': 'plain-value' } });
    const resolved = await service.resolveForExecution({ httpToolIds: JSON.stringify([repo.tools[0]!.id!]) }, 'weather');
    expect(resolved?.tool.headers).toEqual({ 'X-Trace': 'plain-value' });
  });

  it('非敏感头值恰好以 enc: 开头时执行期仍应原样透传，不得送进解密', async () => {
    const repo = fakeRepo();
    const service = makeService(repo);
    await service.create({ ...baseDraft, headers: { 'X-Trace': 'enc:not-a-cipher' } });

    const stored = JSON.parse(repo.tools[0]!.headersJson!) as Record<string, string>;
    expect(stored['X-Trace']).toBe('enc:not-a-cipher');

    const resolved = await service.resolveForExecution({ httpToolIds: JSON.stringify([repo.tools[0]!.id!]) }, 'weather');
    expect(resolved?.tool.headers).toEqual({ 'X-Trace': 'enc:not-a-cipher' });
  });
});

describe('BUG-H2 敏感头改名为非敏感键后，掩码哨兵被当作真实凭据落库', () => {
  it('掩码哨兵不得被当作真实请求头值落库（改键名后直接拒绝保存）', async () => {
    const repo = fakeRepo();
    const service = makeService(repo);
    const created = await service.create({ ...baseDraft, headers: { Authorization: 'Bearer real-secret' } });
    const before = JSON.parse(repo.tools[0]!.headersJson!) as Record<string, string>;
    expect(before['Authorization']).toMatch(/^enc:/);

    // 管理后台编辑表单回显为掩码；管理员把键名从 Authorization 改成 X-Auth（非敏感键）
    // 掩码在 previousStored 里找不到同键旧值 → 拒绝保存并提示重填真实值
    await expect(service.update(created.id!, { ...baseDraft, headers: { 'X-Auth': '******' } }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    // 保存被拒，库里的旧密文保持原样，掩码没有落库
    const row = repo.tools.find((t) => t.name === 'weather')!;
    const after = JSON.parse(row.headersJson!) as Record<string, string>;
    expect(after).toEqual(before);
    expect(Object.values(after)).not.toContain('******');

    const resolved = await service.resolveForExecution({ httpToolIds: JSON.stringify([created.id!]) }, 'weather');
    expect(Object.values(resolved?.tool.headers ?? {})).not.toContain('******');
  });

  it('新增头提交掩码（无旧值可复用）同样拒绝保存', async () => {
    const repo = fakeRepo();
    const service = makeService(repo);
    await expect(service.create({ ...baseDraft, headers: { 'X-Api-Key': '******' } }))
      .rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
    expect(repo.tools).toHaveLength(0);
  });
});
