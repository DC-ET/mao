import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { LlmCallContext } from '../usage/llm-call-context.js';
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
    countActiveTextExcept: vi.fn(),
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

  it('createModelValidatesMaxRequestBodyBytes', async () => {
    const created = await service.createModel(
      'n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null,
      undefined, undefined, undefined, undefined, 50 * 1024 * 1024,
    );
    expect(created.maxRequestBodyBytes).toBe(50 * 1024 * 1024);
    // 必须真的落库：repository 漏字段的话接口返回内存对象看似正常，刷新即丢
    expect(modelRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequestBodyBytes: 50 * 1024 * 1024 }),
    );

    await expect(service.createModel(
      'n', 'p', 'https://x', 'k', 'm', 0, 0, null, 'text', null, null, null,
      undefined, undefined, undefined, undefined, -1,
    )).rejects.toThrow(/请求体上限/);
  });

  it('updateModelPersistsAndClearsMaxRequestBodyBytes', async () => {
    const existing = model(7, 'old', 0, 1);
    existing.maxRequestBodyBytes = 20_000_000;
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);
    const call = (value: number | null | undefined) => service.updateModel(
      7, null, null, null, null, null, null, null, null, null, null, null, null,
      undefined, undefined, undefined, undefined, value,
    );

    await call(50_000_000);
    expect(existing.maxRequestBodyBytes).toBe(50_000_000);
    expect(modelRepo.updateById).toHaveBeenCalledWith(
      expect.objectContaining({ maxRequestBodyBytes: 50_000_000 }),
    );

    await call(undefined);
    expect(existing.maxRequestBodyBytes).toBe(50_000_000); // 未提供 = 保留

    await call(null);
    expect(existing.maxRequestBodyBytes).toBeNull(); // 显式清空
    expect(modelRepo.updateById).toHaveBeenLastCalledWith(
      expect.objectContaining({ maxRequestBodyBytes: null }),
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
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(0);

    await expect(service.updateStatus(3, 2)).rejects.toBeInstanceOf(BusinessException);
    await expect(service.updateStatus(3, 0)).rejects.toBeInstanceOf(BusinessException);

    // 停用只写 status：默认指定是独立语义，取消默认只能走显式 updateModel(isDefault = 0)。
    // 这里顺手清零会绕过 deleteModel 守卫，并让 findDefault()（要求 status = 1）返回 null，
    // 进而把所有 session.model_id 置 NULL。
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(1);
    await service.updateStatus(3, 0);
    expect(defaultModel.status).toBe(0);
    expect(defaultModel.isDefault).toBe(1);
    expect(modelRepo.clearDefaultFlag).not.toHaveBeenCalled();
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

  it('createModelRequiresEcpLoginEnabledForEcpAuthType', async () => {
    // 未注入开关判定（等价未启用）：ecp 抛参数错误
    await expect(service.createModel(
      'm', 'p', 'https://x', '', 'mid', 0, 0, 256000, 'text', 'none', 'openai-compatible', '',
      null, null, null, null, null, 'ecp',
    )).rejects.toThrow('ECP 飞书登录未启用');

    const enabledService = new ModelService(modelRepo, sessionRepo, llmClient, undefined, async () => true);
    const created = await enabledService.createModel(
      'm', 'p', 'https://x', '', 'mid', 0, 0, 256000, 'text', 'none', 'openai-compatible', '',
      null, null, null, null, null, 'ecp',
    );
    expect(created.authType).toBe('ecp');
    expect(vi.mocked(modelRepo.insert)).toHaveBeenCalledWith(expect.objectContaining({ authType: 'ecp' }));
  });

  it('createModelDefaultsToApiKeyAuthType', async () => {
    const created = await service.createModel(
      'm', 'p', 'https://x', 'sk', 'mid', 0, 0, 256000, 'text', 'none', 'openai-compatible', '',
      null, null, null, null, null, null,
    );
    expect(created.authType).toBe('api_key');
  });

  it('updateModelSwitchesAuthTypeWithEcpGate', async () => {
    vi.mocked(modelRepo.findById).mockResolvedValue(model(9, 'switchable', 0, 1));

    // 未启用：切到 ecp 报错
    await expect(service.updateModel(
      9, null, null, null, null, null, null, null, null, null, null,
      undefined, undefined, null, null, null, null, null, 'ecp',
    )).rejects.toThrow('ECP 飞书登录未启用');

    const enabledService = new ModelService(modelRepo, sessionRepo, llmClient, undefined, async () => true);
    const updated = await enabledService.updateModel(
      9, null, null, null, null, null, null, null, null, null, null,
      undefined, undefined, null, null, null, null, null, 'ecp',
    );
    expect(updated.authType).toBe('ecp');
    expect(vi.mocked(modelRepo.updateById)).toHaveBeenCalledWith(expect.objectContaining({ authType: 'ecp' }));

    // 切回 api_key 不要求开关开启
    const back = await service.updateModel(
      9, null, null, null, null, null, null, null, null, null, null,
      undefined, undefined, null, null, null, null, null, 'api_key',
    );
    expect(back.authType).toBe('api_key');
  });

  it('testConnectivityPassesActorUserIdAndModelAuthType', async () => {
    const captured: Array<{ userId: number | null | undefined; authType: string | undefined }> = [];
    const client: LlmChatClient = {
      chat: vi.fn(async (_req, config) => {
        captured.push({ userId: LlmCallContext.get()?.userId, authType: config.authType });
        return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
      }),
    };
    const scopedService = new ModelService(modelRepo, sessionRepo, client);
    const ecpModel = model(21, 'ecp-model', 0, 1);
    ecpModel.authType = 'ecp';
    ecpModel.modelType = 'text';
    vi.mocked(modelRepo.findById).mockResolvedValue(ecpModel);

    const result = await scopedService.testConnectivity(21, 7);
    expect(result.connectivity).toBe(true);
    expect(captured).toEqual([{ userId: 7, authType: 'ecp' }]);
  });

  it('updateModelAllowsEditingEcpModelWhenEcpLoginTurnedOff', async () => {
    const ecpModel = model(31, 'already-ecp', 0, 1);
    ecpModel.authType = 'ecp';
    vi.mocked(modelRepo.findById).mockResolvedValue(ecpModel);
    // 未注入开关判定（等价未启用）：已是 ecp 的模型保存其它字段不被拦（仅切到 ecp 才校验）。
    const updated = await service.updateModel(
      31, 'renamed', null, null, null, null, null, null, null, null, null,
      undefined, undefined, null, null, null, null, null, 'ecp',
    );
    expect(updated.authType).toBe('ecp');
    expect(updated.name).toBe('renamed');
  });

  it('createModelAcceptsMissingApiKeyForEcpAndStoresEmptyString', async () => {
    const enabledService = new ModelService(modelRepo, sessionRepo, llmClient, undefined, async () => true);
    const created = await enabledService.createModel(
      'm', 'p', 'https://x', undefined, 'mid', 0, 0, 256000, 'text', 'none', 'openai-compatible', '',
      null, null, null, null, null, 'ecp',
    );
    expect(created.apiKey).toBe('');
    expect(created.authType).toBe('ecp');
  });
});

describe('ModelService 客户端可选（技术方案 2026-11-24）', () => {
  function makeRepo(): LlmModelRepository {
    return {
      selectPage: vi.fn(),
      listProviders: vi.fn(),
      listActiveText: vi.fn(async () => []),
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
      countActiveTextExcept: vi.fn(async () => 1),
      countEnabledWithApiKey: vi.fn(async () => 1),
    };
  }

  function visibleModel(overrides: Partial<LlmModel> = {}): LlmModel {
    return {
      id: 1,
      name: 'chat',
      provider: 'openai',
      baseUrl: 'https://api.example.test',
      apiKey: 'key',
      modelId: 'gpt-x',
      status: 1,
      isDefault: 0,
      clientVisible: 1,
      ...overrides,
    };
  }

  it('listActiveModels 透传 clientVisibleOnly', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    await service.listActiveModels(true);
    expect(repo.listActiveText).toHaveBeenCalledWith(true);
    await service.listActiveModels();
    expect(repo.listActiveText).toHaveBeenLastCalledWith(false);
  });

  it('createModel：缺省可见；显式 0 落 0；boolean false 也落 0', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });

    const created = await service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, 0, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key',
    );
    expect(created.clientVisible).toBe(1);
    expect(vi.mocked(repo.insert).mock.calls[0][0].clientVisible).toBe(1);

    const hidden = await service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, 0, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', 0,
    );
    expect(hidden.clientVisible).toBe(0);

    const hiddenBool = await service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, 0, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', false,
    );
    expect(hiddenBool.clientVisible).toBe(0);
  });

  it('createModel：默认模型不允许关闭客户端可选', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    await expect(service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, 1, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', 0,
    )).rejects.toBeInstanceOf(BusinessException);
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('createModel：isDefault 传布尔 true 同样触发「默认模型必须可见」', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    await expect(service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, true as unknown as number, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', 0,
    )).rejects.toBeInstanceOf(BusinessException);
    // 布尔 false + 不可见：合法
    const created = await service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, false as unknown as number, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', 0,
    );
    expect(created.isDefault).toBe(0);
    expect(created.clientVisible).toBe(0);
  });

  it('createModel：isDefault 传布尔 true 时清掉旧默认标记（不能出现两个默认）', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    const created = await service.createModel(
      'n', 'openai', 'https://x', 'k', 'm', 0, true as unknown as number, null, 'text', 'none', '', '',
      null, null, null, null, null, 'api_key', 1,
    );
    expect(created.isDefault).toBe(1);
    expect(repo.clearDefaultFlag).toHaveBeenCalledTimes(1);
  });

  it('updateModel：不传 clientVisible 保持原值', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    vi.mocked(repo.findById).mockResolvedValue(visibleModel({ clientVisible: 0 }));
    await service.updateModel(1, 'n2', null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null);
    expect(vi.mocked(repo.updateById).mock.calls[0][0].clientVisible).toBe(0);
  });

  it('updateModel：把默认模型设为不可见被拒；先取消默认再隐藏可以', async () => {
    const repo = makeRepo();
    const service = new ModelService(repo, { reassignModelId: vi.fn() }, { chat: vi.fn() });
    vi.mocked(repo.findById).mockResolvedValue(visibleModel({ isDefault: 1, clientVisible: 1 }));
    // 参数顺序：id, name, provider, baseUrl, apiKey, modelId, supportsVision, isDefault,
    // contextWindowTokens, modelType, clientImpersonation, apiProtocol, effort,
    // priceInput, priceCacheRead, priceCacheWrite, priceOutput, maxRequestBodyBytes, authType, clientVisible
    const args = (isDefault: number | null, clientVisible: number | null) => [
      1, null, null, null, null, null, null, isDefault, null, null,
      null, null, null, null, null, null, null, null, null, clientVisible,
    ] as const;

    await expect(service.updateModel(...args(null, 0))).rejects.toBeInstanceOf(BusinessException);
    expect(repo.updateById).not.toHaveBeenCalled();

    // 同一次请求取消默认 + 关闭可见：最终状态合法，放行
    await service.updateModel(...args(0, 0));
    const saved = vi.mocked(repo.updateById).mock.calls[0][0];
    expect(saved.isDefault).toBe(0);
    expect(saved.clientVisible).toBe(0);
  });
});
