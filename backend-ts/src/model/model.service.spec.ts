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
      'text',
    );
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
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', 'openai'),
    ).rejects.toThrow(/clientImpersonation 只能是/);

    const created = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', 'codex');
    expect(created.clientImpersonation).toBe('codex');
  });

  it('updateModelValidatesClientImpersonationAndKeepsExistingWhenOmitted', async () => {
    const existing = model(7, 'old', 0, 1);
    existing.clientImpersonation = 'claude_code';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(7, null, null, null, null, null, null, null, null, null, 'bogus'),
    ).rejects.toThrow(/clientImpersonation 只能是/);

    // 不传（undefined/null）表示不修改，保留原值
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, null);
    expect(existing.clientImpersonation).toBe('claude_code');
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);

    // 显式改为 none 生效
    await service.updateModel(7, null, null, null, null, null, null, null, null, null, 'none');
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
      null,
    );
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
    const created = await service.createModel('n', 'openai', 'https://x', 'k', 'm', 1, 1, 8000, 'text');
    expect(created.status).toBe(1);
    expect(modelRepo.clearDefaultFlag).toHaveBeenCalled();
    await service.updateModel(1, 'n2', 'p', 'https://y', 'k2', 'm2', 0, 0, 4000, 'text');
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
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'bogus'),
    ).rejects.toThrow(/apiProtocol 只能是/);

    // openai-responses 已实现，可正常保存
    const responsesModel = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses');
    expect(responsesModel.apiProtocol).toBe('openai-responses');

    const normalized = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-compatible');
    expect(normalized.apiProtocol).toBe('');

    const anthropic = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'anthropic');
    expect(anthropic.apiProtocol).toBe('anthropic');

    const omitted = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text');
    expect(omitted.apiProtocol).toBe('');
  });

  it('updateModelValidatesApiProtocolAndKeepsExistingWhenOmitted', async () => {
    const existing = model(11, 'old', 0, 1);
    existing.apiProtocol = 'anthropic';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(11, null, null, null, null, null, null, null, null, null, null, 'bogus'),
    ).rejects.toThrow(/apiProtocol 只能是/);

    // 不传（undefined/null）表示不修改，保留原值
    await service.updateModel(11, null, null, null, null, null, null, null, null, null, null, null);
    expect(existing.apiProtocol).toBe('anthropic');

    // 显式传 openai-compatible 归一为空串并生效
    await service.updateModel(11, null, null, null, null, null, null, null, null, null, null, 'openai-compatible');
    expect(existing.apiProtocol).toBe('');
    expect(modelRepo.updateById).toHaveBeenCalledWith(existing);
  });

  it('createModelValidatesEffortAndNormalizesBlankToEmptyString', async () => {
    await expect(
      service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', 'bogus'),
    ).rejects.toThrow(/effort 只能是/);

    const withEffort = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', 'xhigh');
    expect(withEffort.effort).toBe('xhigh');

    const blank = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses', '  ');
    expect(blank.effort).toBe('');

    const omitted = await service.createModel('n', 'p', 'https://x', 'k', 'm', null, 0, null, 'text', null, 'openai-responses');
    expect(omitted.effort).toBe('');
  });

  it('updateModelValidatesEffortAndKeepsExistingWhenOmitted', async () => {
    const existing = model(13, 'old', 0, 1);
    existing.effort = 'low';
    vi.mocked(modelRepo.findById).mockResolvedValue(existing);

    await expect(
      service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, 'ultra'),
    ).rejects.toThrow(/effort 只能是/);

    // 不传表示不修改
    await service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, null);
    expect(existing.effort).toBe('low');

    // 显式传空串表示回到协议默认
    await service.updateModel(13, null, null, null, null, null, null, null, null, null, null, null, 'high');
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
