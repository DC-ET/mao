/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-1）：
 * createAgent 曾在 isDefault=1 时先执行 clearDefaultFlag（独立 UPDATE，自动提交），
 * 再执行 requireEnabledModel 校验。校验抛错时旧默认 Agent 的 is_default 已被清掉且
 * 新 Agent 未插入 → 全库零默认 Agent，后续 requireDefaultAgent() 失败，
 * 会话创建全面中断，直至管理员人工干预。已修复：校验前置到清旗标之前。
 *
 * 本用例断言「正确行为」：创建失败（默认模型缺失）时旧默认 Agent 的旗标必须保持。
 *
 * 对照：isDefault=0 的既有用例（createRejectsMissingOrDisabledModel）不触发清旗，
 * 因此该交互此前无覆盖。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../common/error-code.js';
import { AgentService } from './agent.service.js';
import type { Agent, AgentRepository } from './types.js';

describe('createAgent 默认旗标交换原子性（回归）', () => {
  /** 状态化仓库：clearDefaultFlag 模拟已提交的 UPDATE（无事务包裹）。 */
  function makeRepo(rows: Agent[]): AgentRepository {
    return {
      selectList: vi.fn(),
      findById: vi.fn(async (id: number) => rows.find((r) => r.id === id) ?? null),
      findDefault: vi.fn(async () => rows.find((r) => r.isDefault === 1) ?? null),
      selectGitAllowedDomainsById: vi.fn(),
      insert: vi.fn(async (a: Agent) => {
        a.id = Math.max(0, ...rows.map((r) => r.id ?? 0)) + 1;
        rows.push(a); // 模拟已提交的 INSERT
        return a.id;
      }),
      updateById: vi.fn(),
      listPromptVersions: vi.fn(),
      rollbackPrompt: vi.fn(),
      deleteById: vi.fn(),
      updateEnabled: vi.fn(),
      clearDefaultFlag: vi.fn(async () => {
        // 真实实现：UPDATE agent SET is_default = 0 WHERE is_default = 1 AND deleted = 0
        for (const r of rows) if (r.isDefault === 1) r.isDefault = 0;
      }),
      removeSkillName: vi.fn(),
    } as unknown as AgentRepository;
  }

  const experienceService = { syncExperiences: vi.fn(), deleteByAgentId: vi.fn(), listByAgentId: vi.fn() };
  const suggestedQuestionService = { syncSuggestedQuestions: vi.fn(), deleteByAgentId: vi.fn(), listByAgentId: vi.fn() };

  it('isDefault=1 + 默认模型缺失：抛错后旧默认 Agent 必须仍是默认', async () => {
    const rows: Agent[] = [{ id: 1, name: 'old-default', systemPrompt: 'p', isDefault: 1 }];
    const repo = makeRepo(rows);
    // 生产接线（create-app.ts:435）：modelRepo 即 modelLookup；模型 404 不存在
    const modelLookup = { findById: vi.fn(async () => null) };
    const service = new AgentService(repo, experienceService as never, suggestedQuestionService as never, modelLookup);

    await expect(
      service.createAgent(7, 'new', null, 'p', null, null, null, null, null, 1, 404),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    // 正确行为：创建失败不得顺手清掉旧默认旗标
    expect(rows.find((r) => r.id === 1)!.isDefault).toBe(1);
    expect(rows.filter((r) => r.isDefault === 1)).toHaveLength(1);
    expect(await repo.findDefault!()).toEqual(expect.objectContaining({ id: 1, isDefault: 1 }));
  });

  it('对照组：isDefault=0 同样抛错且不动旗标（既有行为正确）', async () => {
    const rows: Agent[] = [{ id: 1, name: 'old-default', systemPrompt: 'p', isDefault: 1 }];
    const repo = makeRepo(rows);
    const modelLookup = { findById: vi.fn(async () => null) };
    const service = new AgentService(repo, experienceService as never, suggestedQuestionService as never, modelLookup);

    await expect(
      service.createAgent(7, 'new', null, 'p', null, null, null, null, null, 0, 404),
    ).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });

    expect(rows.find((r) => r.id === 1)!.isDefault).toBe(1);
    expect(rows.filter((r) => r.isDefault === 1)).toHaveLength(1);
  });

  it('对照组：isDefault=1 + 模型可用：正常交换（证明功能本身意图正确）', async () => {
    const rows: Agent[] = [{ id: 1, name: 'old-default', systemPrompt: 'p', isDefault: 1 }];
    const repo = makeRepo(rows);
    const modelLookup = { findById: vi.fn(async (id: number) => (id === 7 ? { id: 7, status: 1 } : null)) };
    const service = new AgentService(repo, experienceService as never, suggestedQuestionService as never, modelLookup);

    const created = await service.createAgent(7, 'new', null, 'p', null, null, null, null, null, 1, 7);
    expect(created.isDefault).toBe(1);
    expect(rows.find((r) => r.id === 1)!.isDefault).toBe(0);
    expect(rows.filter((r) => r.isDefault === 1)).toHaveLength(1);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });
});
