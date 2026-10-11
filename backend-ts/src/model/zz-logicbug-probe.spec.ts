import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ModelService } from './model.service.js';
import type {
  LlmChatClient,
  LlmModel,
  LlmModelRepository,
  SessionModelRepository,
} from './types.js';

/**
 * 回归（BUG-5）：`updateStatus` 停用「默认模型」时曾连带把 is_default 静默清 0。
 *
 * 位置：model.service.ts updateStatus。
 *
 * 事实：updateStatus 只收到 { status: 0 }（admin 启停按钮 ModelListView.vue:506 →
 * PATCH /v1/models/:id/status），却在守卫通过后执行 `model.isDefault = 0; clearDefaultFlag()`，
 * 把「停用」与「取消默认指定」两个语义混为一谈。
 *
 * 修复：updateStatus 只写 status，不得改动 is_default。取消默认只能走显式
 * updateModel(isDefault = 0)。附带把守卫 countActiveExcept 换成带
 * model_type = 'text' 的 countActiveTextExcept——findDefault() 自己带该条件，
 * 拿 audio/image 计数会让守卫误判「还有别的默认可用」。
 */
function model(id: number, name: string, isDefault: number, status: number): LlmModel {
  return {
    id,
    name,
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'key',
    modelId: `model-${name}`,
    modelType: 'text',
    isDefault,
    status,
  };
}

describe('BUG-5 回归：停用默认模型不得清掉 is_default', () => {
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
  const llmClient: LlmChatClient = { chat: vi.fn() };
  const service = new ModelService(modelRepo, sessionRepo, llmClient);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('H1 停用默认模型（还有其它启用 text 模型）时 is_default 必须保持不变', async () => {
    const target = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(1);

    await service.updateStatus(3, 0);

    expect(target.status).toBe(0);
    expect(target.isDefault).toBe(1);
    expect(modelRepo.clearDefaultFlag).not.toHaveBeenCalled();
    expect(modelRepo.updateById).toHaveBeenCalledWith(target);
  });

  it('H2 停用默认模型后 deleteModel 仍须拒绝删除（默认指定未被悄悄取消）', async () => {
    const target = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(1);
    await service.updateStatus(3, 0);

    // 重新读库拿到刚写入的状态（真实仓库按 updateById 的内容落库）
    const stored = model(3, 'default', target.isDefault, target.status);
    vi.mocked(modelRepo.findById).mockResolvedValue(stored);
    await expect(service.deleteModel(3)).rejects.toBeInstanceOf(BusinessException);
    expect(sessionRepo.reassignModelId).not.toHaveBeenCalled();
    expect(modelRepo.deleteById).not.toHaveBeenCalled();
  });

  it('H3 对照组：显式把 isDefault 改成 0 才是取消默认指定的正确路径', async () => {
    const target = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);

    await service.updateModel(
      3, null, null, null, null, null, null, 0, null, null, null, null,
      undefined, undefined, undefined, undefined,
    );

    expect(target.isDefault).toBe(0);
    expect(modelRepo.updateById).toHaveBeenCalledWith(target);
  });

  it('H4 唯一启用的默认模型仍被拒绝停用（守卫未削弱）', async () => {
    const target = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(0);

    await expect(service.updateStatus(3, 0)).rejects.toBeInstanceOf(BusinessException);
    expect(modelRepo.updateById).not.toHaveBeenCalled();
  });

  it('H5 守卫按 text 口径计数：只有 audio/image 时仍拒绝停用', async () => {
    const target = model(3, 'default', 1, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);
    // countActiveTextExcept 已带 model_type = 'text'，audio/image 不计入
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(0);

    await expect(service.updateStatus(3, 0)).rejects.toBeInstanceOf(BusinessException);
  });

  it('H6 非默认模型停用不触碰 is_default 与 clearDefaultFlag', async () => {
    const target = model(4, 'other', 0, 1);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);
    vi.mocked(modelRepo.countActiveTextExcept).mockResolvedValue(1);

    await service.updateStatus(4, 0);

    expect(target.status).toBe(0);
    expect(target.isDefault).toBe(0);
    expect(modelRepo.clearDefaultFlag).not.toHaveBeenCalled();
    expect(modelRepo.countActiveTextExcept).not.toHaveBeenCalled();
  });

  it('H7 重新启用默认模型只写 status=1，不动 is_default', async () => {
    const target = model(3, 'default', 1, 0);
    vi.mocked(modelRepo.findById).mockResolvedValue(target);

    await service.updateStatus(3, 1);

    expect(target.status).toBe(1);
    expect(target.isDefault).toBe(1);
    expect(modelRepo.clearDefaultFlag).not.toHaveBeenCalled();
  });
});
