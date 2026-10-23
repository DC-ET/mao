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
});
