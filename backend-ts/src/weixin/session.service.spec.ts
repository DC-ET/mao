import { describe, expect, it, vi } from 'vitest';
import { WeixinSessionService } from './session.service.js';
import { WEIXIN_AGENT_ID_KEY, WEIXIN_MODEL_ID_KEY } from '../settings/settings.service.js';

describe('WeixinSessionService', () => {
  const sessionService = { createSession: vi.fn() };
  const sessionRepo = { findActiveByUserAndProjectKey: vi.fn(), updateById: vi.fn() };
  const agentService = { getAgent: vi.fn(), requireDefaultAgent: vi.fn() };
  const modelService = { getModel: vi.fn(), getDefaultModel: vi.fn() };
  const systemSettingService = { getValue: vi.fn() };

  const service = new WeixinSessionService(
    sessionService as never,
    sessionRepo as never,
    agentService as never,
    modelService as never,
    systemSettingService as never,
  );

  it('getOrCreateWeixinSessionReturnsExistingSessionAndKeepsAgentAndModel', async () => {
    systemSettingService.getValue.mockImplementation(async (key: string) => (
      key === WEIXIN_AGENT_ID_KEY ? '10' : ''
    ));
    agentService.getAgent.mockResolvedValue({ id: 10, name: 'agent-10' });
    modelService.getDefaultModel.mockResolvedValue({ id: 100, name: 'model-100' });
    const existing = { id: 1, userId: 1, agentId: 10, modelId: 100, projectKey: 'weixin-bot', status: 'ACTIVE' };
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue(existing);

    const result = await service.getOrCreateWeixinSession(1);
    expect(result.id).toBe(1);
    expect(sessionRepo.updateById).not.toHaveBeenCalled();
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('getOrCreateWeixinSessionSwitchesAgentAndModelOnExistingSession', async () => {
    systemSettingService.getValue.mockImplementation(async (key: string) => {
      if (key === WEIXIN_AGENT_ID_KEY) return '20';
      if (key === WEIXIN_MODEL_ID_KEY) return '7';
      return '';
    });
    agentService.getAgent.mockResolvedValue({ id: 20, name: 'agent-20' });
    modelService.getModel.mockResolvedValue({ id: 7, name: 'model-7' });
    const existing = { id: 1, userId: 1, agentId: 10, modelId: 100, projectKey: 'weixin-bot', status: 'ACTIVE' };
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue(existing);

    const result = await service.getOrCreateWeixinSession(1);
    expect(result.agentId).toBe(20);
    expect(result.modelId).toBe(7);
    expect(sessionRepo.updateById).toHaveBeenCalledWith(existing);
    expect(sessionService.createSession).not.toHaveBeenCalled();
  });

  it('getOrCreateWeixinSessionCreatesNewSessionWithConfiguredAgentAndModel', async () => {
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue(null);
    systemSettingService.getValue.mockImplementation(async (key: string) => {
      if (key === WEIXIN_AGENT_ID_KEY) return '5';
      if (key === WEIXIN_MODEL_ID_KEY) return '3';
      return '';
    });
    agentService.getAgent.mockResolvedValue({ id: 5, name: 'agent-5' });
    modelService.getModel.mockResolvedValue({ id: 3, name: 'model-3' });
    sessionService.createSession.mockResolvedValue({ id: 2 });

    const result = await service.getOrCreateWeixinSession(1);
    expect(result.id).toBe(2);
    expect(sessionService.createSession).toHaveBeenCalledWith(
      1, 5, expect.any(String), expect.any(String),
      null, expect.any(String), false, expect.any(String), expect.any(String), expect.any(String),
      3, expect.any(String), expect.any(String), null, null,
      'weixin',
    );
  });

  it('concurrentGetOrCreateForSameUserCreatesOnlyOneSession', async () => {
    sessionService.createSession.mockClear();
    sessionRepo.findActiveByUserAndProjectKey.mockClear();
    systemSettingService.getValue.mockImplementation(async (key: string) => {
      if (key === WEIXIN_AGENT_ID_KEY) return '5';
      if (key === WEIXIN_MODEL_ID_KEY) return '3';
      return '';
    });
    agentService.getAgent.mockResolvedValue({ id: 5, name: 'agent-5' });
    modelService.getModel.mockResolvedValue({ id: 3, name: 'model-3' });

    const created = { id: 2, userId: 1 };
    let sessionCreated = false;
    sessionRepo.findActiveByUserAndProjectKey.mockImplementation(async () => (
      sessionCreated ? created : null
    ));
    let releaseCreate!: () => void;
    const createGate = new Promise<void>((r) => { releaseCreate = r; });
    sessionService.createSession.mockImplementation(async () => {
      await createGate;
      sessionCreated = true;
      return created;
    });

    const p1 = service.getOrCreateWeixinSession(1);
    const p2 = service.getOrCreateWeixinSession(1);
    releaseCreate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.id).toBe(2);
    expect(r2.id).toBe(2);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
  });

  it('resolveWeixinAgentFallsBackWhenConfiguredAgentDisabled', async () => {
    systemSettingService.getValue.mockResolvedValue('10');
    agentService.getAgent.mockResolvedValue({ id: 10, name: 'off', enabled: 0 });
    agentService.requireDefaultAgent.mockResolvedValue({ id: 99, name: 'default' });
    expect((await service.resolveWeixinAgent()).id).toBe(99);
  });

  it('resolveWeixinAgentFallsBackToDefaultWhenUnset', async () => {
    systemSettingService.getValue.mockResolvedValue('');
    agentService.requireDefaultAgent.mockResolvedValue({ id: 99, name: 'default' });
    expect((await service.resolveWeixinAgent()).id).toBe(99);
  });

  it('resolveWeixinModelIdFallsBackToDefaultWhenUnset', async () => {
    systemSettingService.getValue.mockResolvedValue('');
    modelService.getDefaultModel.mockResolvedValue({ id: 55, name: 'm' });
    expect(await service.resolveWeixinModelId()).toBe(55);
  });
});

// round 1 BUG-8：withUserLock 曾把「链式 promise」存进 Map、finally 里却拿 current
// 比较，清理条件永假，userLocks 按 userId 无界泄漏（进程长跑的微信 Bot 每接入一个
// 用户就漏一个条目）。与 weixin/agent-inbound-handler.withSessionLock 对齐：存/比同一引用。
describe('WeixinSessionService withUserLock', () => {
  function makeService() {
    const sessionService = { createSession: vi.fn() };
    const sessionRepo = { findActiveByUserAndProjectKey: vi.fn(), updateById: vi.fn() };
    const agentService = { getAgent: vi.fn(), requireDefaultAgent: vi.fn() };
    const modelService = { getModel: vi.fn(), getDefaultModel: vi.fn() };
    const systemSettingService = { getValue: vi.fn() };
    systemSettingService.getValue.mockImplementation(async (key: string) => (
      key === WEIXIN_AGENT_ID_KEY ? '10' : key === WEIXIN_MODEL_ID_KEY ? '' : ''
    ));
    agentService.getAgent.mockResolvedValue({ id: 10, name: 'agent-10' });
    modelService.getDefaultModel.mockResolvedValue({ id: 100, name: 'model-100' });
    const service = new WeixinSessionService(
      sessionService as never,
      sessionRepo as never,
      agentService as never,
      modelService as never,
      systemSettingService as never,
    );
    return { service, sessionService, sessionRepo };
  }

  /** 取私有锁表。 */
  function locksOf(service: WeixinSessionService): Map<number, Promise<void>> {
    return (service as unknown as { userLocks: Map<number, Promise<void>> }).userLocks;
  }

  it('removes the lock entry after the call returns', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue({ id: 1, userId: 1, agentId: 10, modelId: 100 });

    await service.getOrCreateWeixinSession(1);
    expect(locksOf(service).size).toBe(0);
  });

  it('does not grow the lock table with distinct users', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findActiveByUserAndProjectKey.mockImplementation(async (userId: number) => ({
      id: userId, userId, agentId: 10, modelId: 100,
    }));

    for (let userId = 1; userId <= 20; userId++) {
      await service.getOrCreateWeixinSession(userId);
    }
    expect(locksOf(service).size).toBe(0);
  });

  it('keeps serialization: concurrent calls for one user still create one session', async () => {
    const { service, sessionService, sessionRepo } = makeService();
    let created = false;
    sessionRepo.findActiveByUserAndProjectKey.mockImplementation(async () => (created ? { id: 2, userId: 1 } : null));
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => { releaseCreate = r; });
    sessionService.createSession.mockImplementation(async () => {
      await gate;
      created = true;
      return { id: 2, userId: 1 };
    });

    const p1 = service.getOrCreateWeixinSession(1);
    const p2 = service.getOrCreateWeixinSession(1);
    releaseCreate();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.id).toBe(2);
    expect(r2.id).toBe(2);
    expect(sessionService.createSession).toHaveBeenCalledTimes(1);
    expect(locksOf(service).size).toBe(0);
  });

  it('returns the right session on a repeat call', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue({ id: 7, userId: 3, agentId: 10, modelId: 100 });

    await service.getOrCreateWeixinSession(3);
    const again = await service.getOrCreateWeixinSession(3);
    expect(again.id).toBe(7);
    expect(locksOf(service).size).toBe(0);
  });
});

describe('WeixinSessionService 渠道控制命令三方法（2026-11-22 技术方案）', () => {
  function makeService() {
    const sessionService = { createSession: vi.fn(async () => ({ id: 77, userId: 1, status: 'ACTIVE' })) };
    const sessionRepo = {
      findActiveByUserAndProjectKey: vi.fn(),
      findById: vi.fn(),
      updateFields: vi.fn(async () => 1),
      updateById: vi.fn(async () => undefined),
      listRecentChannelSessionBriefs: vi.fn(async () => []),
    };
    const agentService = { getAgent: vi.fn(), requireDefaultAgent: vi.fn(async () => ({ id: 10, enabled: 1 })) };
    const modelService = { getModel: vi.fn(), getDefaultModel: vi.fn(async () => ({ id: 100 })) };
    const systemSettingService = { getValue: vi.fn(async () => null) };
    const service = new WeixinSessionService(
      sessionService as never, sessionRepo as never, agentService as never,
      modelService as never, systemSettingService as never,
    );
    return { service, sessionService, sessionRepo };
  }

  it('/new：归档当前 ACTIVE 会话并新建（source=weixin，互斥单行）', async () => {
    const { service, sessionService, sessionRepo } = makeService();
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue({ id: 5, userId: 1, status: 'ACTIVE' });
    const created = await service.createNewSession(1);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(5, { status: 'ARCHIVED' });
    expect(sessionService.createSession).toHaveBeenCalledWith(
      1, 10, '微信Bot会话', 'CLOUD', null, 'FULL', false, 'linux', '/bin/bash', 'Linux', 100,
      'weixin-bot', 'new', null, null, 'weixin',
    );
    expect(created.id).toBe(77);
  });

  it('/new：无活跃会话直接新建', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue(null);
    await service.createNewSession(1);
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('/tasks：转发简报查询（weixin 来源，无前缀过滤）', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.listRecentChannelSessionBriefs.mockResolvedValue([{ id: 5, title: 't', phase: null, updatedAt: null }]);
    const briefs = await service.listRecentSessions(1, 5);
    expect(sessionRepo.listRecentChannelSessionBriefs).toHaveBeenCalledWith(1, 'weixin', 5);
    expect(briefs).toHaveLength(1);
  });

  it('/tasks <n> 切换：归属 / projectKey 校验拒绝', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findById.mockResolvedValue({ id: 32, userId: 2, projectKey: 'weixin-bot', status: 'ARCHIVED' });
    expect(await service.switchSession(1, 32)).toEqual({ outcome: 'REJECTED' });
    sessionRepo.findById.mockResolvedValue({ id: 32, userId: 1, projectKey: 'other-key', status: 'ARCHIVED' });
    expect(await service.switchSession(1, 32)).toEqual({ outcome: 'REJECTED' });
    sessionRepo.findById.mockResolvedValue(null);
    expect(await service.switchSession(1, 32)).toEqual({ outcome: 'REJECTED' });
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('/tasks <n> 切换：目标即当前 ACTIVE 返回 CURRENT', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findById.mockResolvedValue({ id: 5, userId: 1, projectKey: 'weixin-bot', status: 'ACTIVE' });
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue({ id: 5, userId: 1, status: 'ACTIVE' });
    expect(await service.switchSession(1, 5)).toEqual({ outcome: 'CURRENT' });
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('/tasks <n> 切换：旧 ACTIVE 翻 ARCHIVED、目标翻 ACTIVE', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findById.mockResolvedValue({ id: 32, userId: 1, projectKey: 'weixin-bot', status: 'ARCHIVED' });
    sessionRepo.findActiveByUserAndProjectKey.mockResolvedValue({ id: 5, userId: 1, status: 'ACTIVE' });
    const result = await service.switchSession(1, 32);
    expect(result).toEqual({ outcome: 'SWITCHED', session: expect.objectContaining({ id: 32, status: 'ACTIVE' }) });
    expect(sessionRepo.updateFields).toHaveBeenNthCalledWith(1, 5, { status: 'ARCHIVED' });
    expect(sessionRepo.updateFields).toHaveBeenNthCalledWith(2, 32, { status: 'ACTIVE' });
  });
});
