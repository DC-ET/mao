import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ModelService } from './model.service.js';
import type {
  LlmChatClient,
  LlmModel,
  LlmModelRepository,
  SessionModelRepository,
} from './types.js';

function model(id: number, name: string, isDefault: number, status: number): LlmModel {
  return {
    id,
    name,
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    modelId: `model-${name}`,
    isDefault,
    status,
  };
}

describe('ModelService', () => {
  const modelRepo: LlmModelRepository = {
    selectPage: vi.fn(),
    listProviders: vi.fn(),
    listActiveText: vi.fn(),
    findFirstActiveByType: vi.fn(),
    findDefault: vi.fn(),
    findById: vi.fn(),
    insert: vi.fn(async (m) => {
      m.id = m.id ?? 1;
      return m.id;
    }),
    updateById: vi.fn(),
    deleteById: vi.fn(),
    clearDefaultFlag: vi.fn(),
    countActiveExcept: vi.fn(),
  };
  const sessionRepo: SessionModelRepository = {
    reassignModelId: vi.fn(),
  };
  const llmClient: LlmChatClient = {
    chat: vi.fn(),
  };
  const service = new ModelService(modelRepo, sessionRepo, llmClient);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(modelRepo.insert).mockImplementation(async (m) => {
      m.id = m.id ?? 1;
      return m.id;
    });
  });

  it('listAndLookupMethodsDelegateToMapper', async () => {
    const expectedPage = { records: [] as LlmModel[], total: 0 };
    const active = [model(1, 'gpt', 0, 1)];
    const defaultModel = model(2, 'default', 1, 1);
    vi.mocked(modelRepo.selectPage).mockResolvedValue(expectedPage);
    vi.mocked(modelRepo.listActiveText).mockResolvedValue(active);
    vi.mocked(modelRepo.findDefault).mockResolvedValue(defaultModel);
    vi.mocked(modelRepo.listProviders).mockResolvedValue([' anthropic ', 'openai', '', 7 as unknown as string]);

    const page = await service.listModels(2, 5, null, null, null, null, null, null);
    expect(page.records).toBe(expectedPage.records);
    expect(page.page).toBe(2);
    expect(page.size).toBe(5);
    expect(await service.listProviders()).toEqual(['anthropic', 'openai']);
    expect(await service.listActiveModels()).toEqual(active);
    expect(await service.getDefaultModel()).toBe(defaultModel);
  });

  it('getModelThrowsWhenMissing', async () => {
    vi.mocked(modelRepo.findById).mockResolvedValue(null);
    await expect(service.getModel(99)).rejects.toBeInstanceOf(BusinessException);
  });

  it('createModelAppliesDefaultsAndClearsExistingDefault', async () => {
    const created = await service.createModel(
      '  Name  ',
      'openai',
      'https://api',
      'key',
      'gpt-4o',
      null,
      1,
      128000,
      'text', undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(created.name).toBe('  Name  ');
    expect(created.supportsVision).toBe(0);
    expect(created.isDefault).toBe(1);
    expect(created.contextWindowTokens).toBe(128000);
    expect(created.status).toBe(1);
    expect(created.clientImpersonation).toBe('none');
    expect(modelRepo.clearDefaultFlag).toHaveBeenCalled();
    expect(modelRepo.insert).toHaveBeenCalledWith(created);
  });

  it('createModelRejectsInvalidClientImpersonationAndAcceptsValidValues', async () => {
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', 'openai', undefined, undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/clientImpersonation 只能是/);

    const created = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', 'codex', undefined, undefined, undefined, undefined, undefined, undefined);
    expect(created.clientImpersonation).toBe('codex');
  });

  it('createModelPricesNormalizeToCostColumns', async () => {
    const priced = await service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, 2.5, null, null, 8);
    expect(priced.priceInput).toBe(2.5);
    expect(priced.priceOutput).toBe(8);

    // 未提供（undefined）→ null：不计成本
    const unpriced = await service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, undefined, undefined, undefined, undefined);
    expect(unpriced.priceInput).toBeNull();
    expect(unpriced.priceOutput).toBeNull();

    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, -1, null, null, 8),
    ).rejects.toThrow(/priceInput 必须是非负数字/);
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, 2, null, null, '8' as never),
    ).rejects.toThrow(/priceOutput 必须是非负数字/);

    // 与 updateModel 同一套 DECIMAL(12,6) 校验，create 路径同样拦得住（不落到 insert）
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, 1000000, null, null, null),
    ).rejects.toThrow(/priceInput 不能超过 999999\.999999/);
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null, 0.0000004, null, null, null),
    ).rejects.toThrow(/priceInput 最多保留 6 位小数/);
    expect(modelRepo.insert).not.toHaveBeenCalledWith(
      expect.objectContaining({ priceInput: 1000000 }),
    );
  });

  it('updateModelPricesDistinguishOmittedFromExplicitNull', async () => {
    const existing = model(7, 'old', 0, 1);
    existing.priceInput = 2;
    existing.priceOutput = 8;
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    // 未提供 → 保留原价（字段缺省走 undefined）
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, null, null, null, undefined, undefined, undefined, undefined);
    expect(existing.priceInput).toBe(2);
    expect(existing.priceOutput).toBe(8);

    // 显式 null → 清空（前端清空输入框即此语义）
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null);
    expect(existing.priceInput).toBeNull();
    expect(existing.priceOutput).toBeNull();
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);

    // 非法值拒绝
    existing.priceInput = 1;
    await expect(
      service.updateModel(7, null, null, null, null, null, null, null, null, null, null, null, null, -0.5, null, null, null),
    ).rejects.toThrow(/priceInput 必须是非负数字/);
  });

  // 回归：price_input / price_output 是 DECIMAL(12,6)。不校验值域时，上限外的价格会一路
  // 走到 MySQL 触发 1264（严格模式下 insert/update 失败）让接口 500；小数位超过 6 位则被
  // 数据库静默四舍五入，0.0000004 落库成 0，一个计费模型就此变成"免费模型"。
  it('updateModelPricesRejectValuesOutsideDecimal126Range', async () => {
    const existing = model(7, 'old', 0, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);
    const call = (priceInput: number | null, priceOutput: number | null = null) =>
      service.updateModel(7, null, null, null, null, null, null, null, null, null, null, null, null, priceInput, undefined, undefined, priceOutput);
    const call2 = (priceInput: number | null, priceCacheRead: number | null, priceCacheWrite: number | null, priceOutput: number | null = null) =>
      service.updateModel(7, null, null, null, null, null, null, null, null, null, null, null, null, priceInput, priceCacheRead, priceCacheWrite, priceOutput);

    // 值域上界：DECIMAL(12,6) 整数位 6 位，最大 999999.999999
    await expect(call(1000000)).rejects.toThrow(/不能超过 999999\.999999/);
    await expect(call(1e12)).rejects.toThrow(/不能超过 999999\.999999/);
    await expect(call(null, 1000000)).rejects.toThrow(/priceOutput 不能超过/);

    // 精度：四舍五入后值会变的输入一律拒绝，绝不替用户取整
    await expect(call(0.0000004)).rejects.toThrow(/priceInput 最多保留 6 位小数/);
    await expect(call(null, 2.3456789)).rejects.toThrow(/priceOutput 最多保留 6 位小数/);

    // 缓存两档（priceCacheRead / priceCacheWrite）走同一套值域与精度校验
    await expect(call2(null, 1000000, null)).rejects.toThrow(/priceCacheRead 不能超过/);
    await expect(call2(null, 0.0000004, null)).rejects.toThrow(/priceCacheRead 最多保留 6 位小数/);
    await expect(call2(null, null, 1000000)).rejects.toThrow(/priceCacheWrite 不能超过/);
    await expect(call2(null, null, 0.0000004)).rejects.toThrow(/priceCacheWrite 最多保留 6 位小数/);

    expect(modelRepo.updateById).not.toHaveBeenCalled();

    // 边界内放行：0（免费模型）与上限本身都合法，且原值落库不抖动
    await expect(call(999999.999999, 0)).resolves.toBe(existing);
    expect(existing.priceInput).toBe(999999.999999);
    expect(existing.priceOutput).toBe(0);
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('updateModelValidatesClientImpersonationAndKeepsExistingWhenOmitted', async () => {
    const existing = model(7, 'old', 0, 1);
    existing.clientImpersonation = 'claude_code';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(7, null, null, null, null, null, null, null, null, null, 'bogus', undefined, undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/clientImpersonation 只能是/);

    // 不传（undefined/null）表示不修改，保留原值
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, null, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(existing.clientImpersonation).toBe('claude_code');
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);

    // 显式改为 none 生效
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, 'none', undefined, undefined, undefined, undefined, undefined, undefined);
    expect(existing.clientImpersonation).toBe('none');
  });

  it('updateModelOnlyChangesProvidedFieldsAndCanSetDefault', async () => {
    const existing = model(7, 'old', 0, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    const updated = await service.updateModel(
      7,
      'new',
      null,
      'https://new',
      null,
      'gpt-4.1',
      1,
      1,
      256000,
      null, undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(updated.name).toBe('new');
    expect(updated.provider).toBe('openai');
    expect(updated.baseUrl).toBe('https://new');
    expect(updated.modelId).toBe('gpt-4.1');
    expect(updated.supportsVision).toBe(1);
    expect(updated.isDefault).toBe(1);
    expect(updated.contextWindowTokens).toBe(256000);
    expect(modelRepo.clearDefaultFlag).toHaveBeenCalled();
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('deleteModelRejectsDefaultAndReassignsSessionsForNormalModel', async () => {
    const defaultModel = model(1, 'default', 1, 1);
    const oldModel = model(2, 'old', 0, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(defaultModel);
    await expect(service.deleteModel(1)).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(modelRepo.findById).mockResolvedValue(oldModel);
    vi.mocked(modelRepo.findDefault).mockResolvedValue(defaultModel);
    await service.deleteModel(2);
    expect(sessionRepo.reassignModelId).toHaveBeenCalledWith(2, 1);
    expect(modelRepo.deleteById).toHaveBeenCalledWith(2);
  });

  it('updateStatusValidatesValueAndProtectsOnlyActiveDefault', async () => {
    const defaultModel = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(defaultModel);
    vi.mocked(modelRepo.countActiveExcept).mockResolvedValue(0);

    await expect(service.updateStatus(3, 2)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.updateStatus(3, 0)).rejects.toBeInstanceOf(BusinessException);

    vi.mocked(modelRepo.countActiveExcept).mockResolvedValue(1);
    await service.updateStatus(3, 0);
    expect(defaultModel.status).toBe(0);
    expect(defaultModel.isDefault).toBe(0);
    expect(modelRepo.updateById).toHaveBeenCalledWith(defaultModel);
  });

  it('testConnectivityCallsAdapterAndWrapsFailure', async () => {
    const llmModel = model(8, 'ok', 0, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(llmModel);
    vi.mocked(llmClient.chat).mockResolvedValue({ choices: [] });

    let result = await service.testConnectivity(8);
    expect(result).toEqual({
      connectivity: true,
      connectivityOutput: null,
      durationMs: expect.any(Number),
    });
    expect(llmClient.chat).toHaveBeenCalledTimes(1);
    expect(llmClient.chat).toHaveBeenCalledWith(
      { messages: [{ role: 'user', content: 'Hi' }] },
      expect.objectContaining({ modelId: 'model-ok' }),
    );

    vi.mocked(llmClient.chat).mockClear();
    vi.mocked(llmClient.chat).mockRejectedValue(new Error('boom'));
    result = await service.testConnectivity(8);
    expect(result).toEqual({
      connectivity: false,
      connectivityOutput: null,
      error: '连通性测试失败: boom',
      durationMs: expect.any(Number),
    });
    expect(llmClient.chat).toHaveBeenCalledTimes(1);
  });

  it('lists creates updates and lookups', async () => {
    vi.mocked(modelRepo.selectPage).mockResolvedValue({ records: [model(1, 'a', 1, 1)], total: 1 });
    vi.mocked(modelRepo.listProviders).mockResolvedValue(['openai', ' ', '']);
    vi.mocked(modelRepo.listActiveText).mockResolvedValue([model(1, 'a', 1, 1)]);
    vi.mocked(modelRepo.findFirstActiveByType).mockResolvedValue(model(2, 'img', 0, 1));
    vi.mocked(modelRepo.findDefault).mockResolvedValue(model(1, 'a', 1, 1));
    vi.mocked(modelRepo.findById).mockResolvedValue(model(1, 'a', 1, 1));
    expect((await service.listModels(1, 10, 'a', 'openai', 1, 1, 1, 'text')).total).toBe(1);
    expect(await service.listProviders()).toEqual(['openai']);
    expect((await service.listActiveModels())[0].id).toBe(1);
    expect((await service.findFirstActiveImageModel())?.id).toBe(2);
    expect((await service.findFirstActiveAudioModel())?.id).toBe(2);
    expect((await service.getDefaultModel())?.id).toBe(1);
    expect((await service.getModel(1)).name).toBe('a');
    const created = await service.createModel('n', 'openai', 'https://x', 'k', 'm', 1, 1, 8000, 'text', undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(created.status).toBe(1);
    expect(modelRepo.clearDefaultFlag).toHaveBeenCalled();
    await service.updateModel(1, 'n2', 'p', 'https://y', 'k2', 'm2', 0, 0, 4000, 'text', undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(modelRepo.updateById).toHaveBeenCalled();
  });

  it('testConnectivityPassesClientImpersonationToAdapter', async () => {
    const llmModel = model(9, 'impersonated', 0, 1);
    llmModel.clientImpersonation = 'claude_code';
    vi.mocked(modelRepo.findById).mockResolvedValue(llmModel);
    vi.mocked(llmClient.chat).mockResolvedValue({
      choices: [{ message: { role: 'assistant', content: 'hey' } }],
    });

    const result = await service.testConnectivity(9);
    expect(result.connectivityOutput).toBe('hey');
    expect(llmClient.chat).toHaveBeenCalledTimes(1);
    expect(vi.mocked(llmClient.chat).mock.calls[0][1].clientImpersonation).toBe('claude_code');
  });

  it('createModelNormalizesApiProtocolAndRejectsInvalidValue', async () => {
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'bogus', undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/apiProtocol 只能是/);

    // openai-responses 已实现，可正常保存
    const responsesModel = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', undefined, undefined, undefined, undefined, undefined);
    expect(responsesModel.apiProtocol).toBe('openai-responses');

    const normalized = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-compatible', undefined, undefined, undefined, undefined, undefined);
    expect(normalized.apiProtocol).toBe('');

    const anthropic = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'anthropic', undefined, undefined, undefined, undefined, undefined);
    expect(anthropic.apiProtocol).toBe('anthropic');

    const omitted = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', undefined, undefined, undefined, undefined, undefined, undefined, undefined);
    expect(omitted.apiProtocol).toBe('');
  });

  it('updateModelValidatesApiProtocolAndKeepsExistingWhenOmitted', async () => {
    const existing = model(11, 'old', 0, 1);
    existing.apiProtocol = 'anthropic';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(11, null, null, null, null, null, null, null, null, null, null, 'bogus', undefined, undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/apiProtocol 只能是/);

    // 不传（undefined/null）表示不修改，保留原值
    await service.updateModel(11, null, null, null, null, null, null, null, null, null, null, null, undefined, undefined, undefined, undefined, undefined);
    expect(existing.apiProtocol).toBe('anthropic');

    // 显式传 openai-compatible 归一为空串并生效
    await service.updateModel(11, null, null, null, null, null, null, null, null, null, null, 'openai-compatible', undefined, undefined, undefined, undefined, undefined);
    expect(existing.apiProtocol).toBe('');
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('createModelValidatesEffortAndNormalizesBlankToEmptyString', async () => {
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', 'bogus', undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/effort 只能是/);

    const withEffort = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', 'xhigh', undefined, undefined, undefined, undefined);
    expect(withEffort.effort).toBe('xhigh');

    const blank = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', '  ', undefined, undefined, undefined, undefined);
    expect(blank.effort).toBe('');

    const omitted = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', undefined, undefined, undefined, undefined, undefined);
    expect(omitted.effort).toBe('');
  });

  it('updateModelValidatesEffortAndKeepsExistingWhenOmitted', async () => {
    const existing = model(13, 'old', 0, 1);
    existing.effort = 'low';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, 'ultra', undefined, undefined, undefined, undefined),
    ).rejects.toThrow(/effort 只能是/);

    // 不传表示不修改
    await service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, null, undefined, undefined, undefined, undefined);
    expect(existing.effort).toBe('low');

    // 显式传空串表示回到协议默认
    await service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, 'high', undefined, undefined, undefined, undefined);
    expect(existing.effort).toBe('high');
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('testConnectivityRoutesByApiProtocolNotProvider', async () => {
    const anthropicClient: LlmChatClient = { chat: vi.fn() };
    const responsesClient: LlmChatClient = { chat: vi.fn() };
    const routedService = new ModelService(
      modelRepo, sessionRepo, llmClient,
      new Map([['anthropic', anthropicClient], ['openai-responses', responsesClient]]),
    );
    vi.mocked(llmClient.chat).mockImplementation(async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
    vi.mocked(anthropicClient.chat as never).mockImplementation(async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));
    vi.mocked(responsesClient.chat as never).mockImplementation(async () => ({ choices: [{ message: { role: 'assistant', content: 'hi' } }] }));

    // apiProtocol=anthropic 走 anthropic 客户端
    const anthropicModel = model(12, 'claude', 0, 1);
    anthropicModel.apiProtocol = 'anthropic';
    anthropicModel.modelType = 'text';
    vi.mocked(modelRepo.findById).mockResolvedValue(anthropicModel);
    await routedService.testConnectivity(12);
    expect(anthropicClient.chat).toHaveBeenCalled();

    // apiProtocol=openai-responses 走 responses 客户端
    vi.mocked(anthropicClient.chat as never).mockClear();
    const responsesModel = model(14, 'gpt-5', 0, 1);
    responsesModel.apiProtocol = 'openai-responses';
    responsesModel.modelType = 'text';
    vi.mocked(modelRepo.findById).mockResolvedValue(responsesModel);
    await routedService.testConnectivity(14);
    expect(responsesClient.chat).toHaveBeenCalled();
    expect(anthropicClient.chat).not.toHaveBeenCalled();

    // provider 为渠道名、apiProtocol 为空时走默认 OpenAI 客户端（存量行为不变）
    vi.mocked(anthropicClient.chat as never).mockClear();
    vi.mocked(responsesClient.chat as never).mockClear();
    vi.mocked(llmClient.chat).mockClear();
    const legacyModel = model(13, 'legacy', 0, 1);
    legacyModel.provider = 'anthropic';
    legacyModel.modelType = 'text';
    vi.mocked(modelRepo.findById).mockResolvedValue(legacyModel);
    await routedService.testConnectivity(13);
    expect(llmClient.chat).toHaveBeenCalled();
    expect(anthropicClient.chat).not.toHaveBeenCalled();
    expect(responsesClient.chat).not.toHaveBeenCalled();
  });

  it.each(['openai-compatible', 'anthropic', 'openai-responses'])(
    'testConnectivityMakesOnlyOneBasicCallForProtocol %s',
    async (apiProtocol) => {
      const client: LlmChatClient = {
        chat: vi.fn().mockResolvedValue({
          choices: [{ message: { role: 'assistant', content: 'Hello' } }],
        }),
      };
      const routedService = new ModelService(modelRepo, sessionRepo, llmClient, new Map([[apiProtocol, client]]));
      const llmModel = model(15, 'test', 0, 1);
      llmModel.apiProtocol = apiProtocol;
      llmModel.modelType = 'text';
      vi.mocked(modelRepo.findById).mockResolvedValue(llmModel);

      const result = await routedService.testConnectivity(15);

      expect(result).toEqual({
        connectivity: true,
        connectivityOutput: 'Hello',
        durationMs: expect.any(Number),
      });
      expect(client.chat).toHaveBeenCalledTimes(1);
      expect(client.chat).toHaveBeenCalledWith(
        { messages: [{ role: 'user', content: 'Hi' }] },
        expect.objectContaining({ apiProtocol }),
      );
      expect(llmClient.chat).not.toHaveBeenCalled();
    },
  );
});
