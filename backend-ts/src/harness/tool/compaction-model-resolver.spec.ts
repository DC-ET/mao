import { describe, expect, it, vi } from 'vitest';
import { CompactionModelResolver } from './compaction-model-resolver.js';
import { llmModelToConfig } from '../deps.js';
import type { LlmModel } from '../../model/types.js';

function model(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    id: 3,
    name: 'gpt',
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    modelId: 'gpt-4o',
    modelType: 'text',
    status: 1,
    deleted: 0,
    ...overrides,
  } as LlmModel;
}

function build(setting: string | null, found: LlmModel | null) {
  const settingLookup = vi.fn(async () => setting);
  const modelLookup = vi.fn(async () => found);
  return { resolver: new CompactionModelResolver(settingLookup, modelLookup), settingLookup, modelLookup };
}

const SESSION_MODEL = { id: 9, name: 'session-model', baseUrl: 'https://session.test', apiKey: 'k', modelId: 'session-model' };

describe('CompactionModelResolver', () => {
  it('未配置（空串 / null）→ 回落会话模型', async () => {
    for (const setting of ['', null]) {
      const h = build(setting, model());
      expect(await h.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
      expect(h.modelLookup).not.toHaveBeenCalled();
    }
  });

  it('配置非数字 / 非正整数 → 回落', async () => {
    for (const setting of ['abc', '0', '-3', '1.5']) {
      const h = build(setting, model());
      expect(await h.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
      expect(h.modelLookup).not.toHaveBeenCalled();
    }
  });

  it('模型不存在或已删 → 回落', async () => {
    const missing = build('3', null);
    expect(await missing.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
    const deleted = build('3', model({ deleted: 1 }));
    expect(await deleted.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
    expect(deleted.modelLookup).toHaveBeenCalledWith(3);
  });

  it('模型停用（status != 1）→ 回落；status 缺失视为启用', async () => {
    const disabled = build('3', model({ status: 0 }));
    expect(await disabled.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
    const noStatus = build('3', model({ status: null as unknown as number }));
    expect(await noStatus.resolver.resolve(SESSION_MODEL as never))
      .toEqual(llmModelToConfig(model({ status: null as unknown as number })));
  });

  it('model_type 非文本 → 回落', async () => {
    const audio = build('3', model({ modelType: 'audio' }));
    expect(await audio.resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
  });

  it('配置有效 → 返回该模型的 LlmModelConfig（含价格下发）', async () => {
    const h = build('3', model({ priceInput: '2.5' as never, priceOutput: '8' as never }));
    const resolved = await h.resolver.resolve(SESSION_MODEL as never);
    expect(resolved).toEqual(llmModelToConfig(model({ priceInput: '2.5' as never, priceOutput: '8' as never })));
    expect(resolved).toMatchObject({ id: 3, modelId: 'gpt-4o', priceInput: 2.5, priceOutput: 8 });
  });

  it('会话模型本身为 null 且配置失效 → 回落 null', async () => {
    const h = build('abc', null);
    expect(await h.resolver.resolve(null)).toBeNull();
  });

  it('系统设置读取异常 → 回落', async () => {
    const settingLookup = vi.fn(async () => { throw new Error('db down'); });
    const modelLookup = vi.fn();
    const resolver = new CompactionModelResolver(settingLookup, modelLookup);
    expect(await resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
    expect(modelLookup).not.toHaveBeenCalled();
  });

  it('模型查询异常 → 回落', async () => {
    const settingLookup = vi.fn(async () => '3');
    const modelLookup = vi.fn(async () => { throw new Error('db down'); });
    const resolver = new CompactionModelResolver(settingLookup, modelLookup);
    expect(await resolver.resolve(SESSION_MODEL as never)).toBe(SESSION_MODEL);
  });
});
