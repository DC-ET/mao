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
    );
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
