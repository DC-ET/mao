import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/db.js';
import { MysqlLlmModelRepository } from './model.repository.js';
import type { LlmModel } from './types.js';

function model(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    name: 'm',
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'k',
    modelId: 'gpt',
    ...overrides,
  };
}

/**
 * 落库字段清单回归测试：`db.insert/updateById` 只按传入对象的 key 生成 SQL，
 * 漏一个字段不会报错，只会让「接口返回正常、刷新即丢」——service 层单测发现不了。
 */
describe('MysqlLlmModelRepository', () => {
  it('persists maxRequestBodyBytes on insert', async () => {
    const db = { insert: vi.fn(async () => 3), updateById: vi.fn() };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    await repo.insert(model({ maxRequestBodyBytes: 50_000_000 }));
    expect(db.insert).toHaveBeenCalledWith('llm_model', expect.objectContaining({
      maxRequestBodyBytes: 50_000_000,
    }));
  });

  it('writes null when maxRequestBodyBytes is undefined', async () => {
    const db = { insert: vi.fn(async () => 4), updateById: vi.fn() };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    await repo.insert(model());
    expect(db.insert).toHaveBeenCalledWith('llm_model', expect.objectContaining({
      maxRequestBodyBytes: null,
    }));
  });

  it('updates and clears maxRequestBodyBytes', async () => {
    const db = { insert: vi.fn(), updateById: vi.fn() };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    await repo.updateById(model({ id: 3, maxRequestBodyBytes: 32_000_000 }));
    expect(db.updateById).toHaveBeenCalledWith('llm_model', 3, expect.objectContaining({
      maxRequestBodyBytes: 32_000_000,
    }));

    await repo.updateById(model({ id: 3, maxRequestBodyBytes: null }));
    expect(db.updateById).toHaveBeenLastCalledWith('llm_model', 3, expect.objectContaining({
      maxRequestBodyBytes: null,
    }));
  });

  it('findFirstActiveAudioModel only accepts OpenAI-compatible protocols', async () => {
    const row = model({ id: 9, modelType: 'audio', apiProtocol: 'openai-compatible' });
    const db = { queryOne: vi.fn(async () => row) };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    expect(await repo.findFirstActiveAudioModel()).toBe(row);
    const sql = String(db.queryOne.mock.calls[0]?.[0]);
    expect(sql).toContain("model_type = 'audio'");
    expect(sql).toContain('api_protocol IS NULL');
    expect(sql).toContain("api_protocol = 'openai-compatible'");
    expect(sql).toContain('deleted = 0');
    expect(sql).toContain('ORDER BY id ASC');
  });

  it('findDefaultByType：按类型取启用默认；audio 附加协议兼容过滤', async () => {
    const row = model({ id: 12, modelType: 'image', isDefault: 1 });
    const db = { queryOne: vi.fn(async () => row) };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);

    expect(await repo.findDefaultByType('image')).toBe(row);
    let sql = String(db.queryOne.mock.calls[0]?.[0]);
    let params = db.queryOne.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain('is_default = 1');
    expect(sql).toContain('status = 1');
    expect(sql).toContain('model_type = ?');
    expect(sql).not.toContain('api_protocol');
    expect(params).toEqual(['image']);

    // audio：附加重建协议兼容过滤（防脏数据默认「成功但无音频」）
    db.queryOne.mockClear();
    await repo.findDefaultByType('audio');
    sql = String(db.queryOne.mock.calls[0]?.[0]);
    params = db.queryOne.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain("api_protocol = 'openai-compatible'");
    expect(params).toEqual(['audio']);
  });

  it('clearDefaultFlag：只清同类型默认（按 model_type 作用域）', async () => {
    const db = { execute: vi.fn(async () => ({})) };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    await repo.clearDefaultFlag('image');
    const sql = String(db.execute.mock.calls[0]?.[0]);
    const params = db.execute.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain('UPDATE llm_model SET is_default = 0');
    expect(sql).toContain('model_type = ?');
    expect(sql).toContain('deleted = 0');
    expect(params).toEqual(['image']);
  });

  it('listActiveByType：启用未删按 id ASC；audio 附加协议过滤', async () => {
    const db = { query: vi.fn(async () => []) };
    const repo = new MysqlLlmModelRepository(db as unknown as Db);
    await repo.listActiveByType('audio');
    const sql = String(db.query.mock.calls[0]?.[0]);
    const params = db.query.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain('status = 1');
    expect(sql).toContain('model_type = ?');
    expect(sql).toContain('ORDER BY id ASC');
    expect(sql).toContain("api_protocol = 'openai-compatible'");
    expect(params).toEqual(['audio']);
  });
});
