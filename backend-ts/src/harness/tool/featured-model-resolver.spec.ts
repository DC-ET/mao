import { describe, expect, it, vi } from 'vitest';
import { DefaultFeaturedModelResolver } from './featured-model-resolver.js';
import type { LlmModel } from '../../model/types.js';

function model(id: number, overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    id,
    name: `model-${id}`,
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    modelId: `mid-${id}`,
    modelType: 'image',
    apiProtocol: '',
    status: 1,
    isDefault: 0,
    ...overrides,
  };
}

/**
 * 默认数据：12=绑定图片（启用）；13=绑定图片（停用）；14=绑定语音但协议不兼容；15=文本模型；
 * 5=语音默认（启用、协议兼容）；6=首个启用语音（协议兼容）。
 */
function makeLookup() {
  const modelLookup = {
    findById: vi.fn(async (id: number) => {
      if (id === 12) return model(12);
      if (id === 13) return model(13, { status: 0 });
      if (id === 14) return model(14, { modelType: 'audio', apiProtocol: 'anthropic' });
      if (id === 15) return model(15, { modelType: 'text' });
      if (id === 16) return model(16, { modelType: 'audio' });
      return null; // 已删除 / 不存在
    }),
    findDefaultByType: vi.fn(async (type: string) =>
      type === 'image'
        ? model(90, { modelType: 'image', isDefault: 1 })
        : model(5, { modelType: 'audio', isDefault: 1 })),
    findFirstActiveByType: vi.fn(async () => model(91, { modelType: 'image' })),
    findFirstActiveAudioModel: vi.fn(async () => model(6, { modelType: 'audio' })),
  };
  const agentLookup = {
    selectById: vi.fn(async (id: number) => {
      if (id === 2) return { id: 2, imageModelId: 12, audioModelId: 16 };
      if (id === 3) return { id: 3, imageModelId: null, audioModelId: null };
      return null; // agent 不存在
    }),
  };
  return { modelLookup, agentLookup };
}

describe('DefaultFeaturedModelResolver（2026-11-27 默认模型 + Agent 指定模型）', () => {
  it('绑定可用模型 → 用绑定模型', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    const resolved = await resolver.resolveImageModel({ imageModelId: 12 });
    expect(resolved?.id).toBe(12);
    // 绑定时不查默认链
    expect(modelLookup.findDefaultByType).not.toHaveBeenCalled();
  });

  it('绑定模型停用 / 删除 / 类型不匹配 → null，不回退默认（fail-closed）', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    // 停用
    expect(await resolver.resolveImageModel({ imageModelId: 13 })).toBeNull();
    // 删除（findById 返回 null）
    expect(await resolver.resolveImageModel({ imageModelId: 404 })).toBeNull();
    // 类型不匹配（图片位绑了文本模型）
    expect(await resolver.resolveImageModel({ imageModelId: 15 })).toBeNull();
    // 全程不回退默认链
    expect(modelLookup.findDefaultByType).not.toHaveBeenCalled();
    expect(modelLookup.findFirstActiveByType).not.toHaveBeenCalled();
  });

  it('audio 绑定协议不兼容 → null（不序列化 audio 的协议不能用）', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    expect(await resolver.resolveAudioModel({ audioModelId: 14 })).toBeNull();
    // 图片绑定到 audio 位 → 类型不匹配
    expect(await resolver.resolveAudioModel({ audioModelId: 12 })).toBeNull();
  });

  it('未绑定 → 显式默认；无默认 → 首个启用兜底', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    expect((await resolver.resolveImageModel(null))?.id).toBe(90);
    expect((await resolver.resolveAudioModel({ audioModelId: null }))?.id).toBe(5);

    // 无默认 → 首个启用（改造前行为兜底）
    modelLookup.findDefaultByType.mockResolvedValue(null);
    expect((await resolver.resolveImageModel(null))?.id).toBe(91);
    expect((await resolver.resolveAudioModel(null))?.id).toBe(6);

    // 默认与首个启用都缺失 → null
    modelLookup.findFirstActiveByType.mockResolvedValue(null);
    modelLookup.findFirstActiveAudioModel.mockResolvedValue(null);
    expect(await resolver.resolveImageModel(null)).toBeNull();
    expect(await resolver.resolveAudioModel(null)).toBeNull();
  });

  it('resolve*ForAgent：agent 不存在按未绑定处理（走默认链）', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    expect((await resolver.resolveImageModelForAgent(404))?.id).toBe(90);
    expect((await resolver.resolveImageModelForAgent(null))?.id).toBe(90);
    expect(agentLookup.selectById).toHaveBeenCalledTimes(1); // agentId=null 不查库
  });

  it('resolve*ForAgent 与直接传 agent 对象结果一致', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    const agent = await agentLookup.selectById(2);
    expect((await resolver.resolveImageModelForAgent(2))?.id)
      .toBe((await resolver.resolveImageModel(agent))?.id);
    expect((await resolver.resolveAudioModelForAgent(2))?.id)
      .toBe((await resolver.resolveAudioModel(agent))?.id);
  });

  it('findImageModel / findAudioModel 是 resolve*ForAgent 的工具端口适配（同义）', async () => {
    const { modelLookup, agentLookup } = makeLookup();
    const resolver = new DefaultFeaturedModelResolver(modelLookup, agentLookup);
    expect((await resolver.findImageModel(2))?.id).toBe(12);
    expect((await resolver.findAudioModel(2))?.id).toBe(16);
    expect((await resolver.findImageModel(null))?.id).toBe(90);
  });
});
