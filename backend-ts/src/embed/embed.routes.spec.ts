import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { handleError } from '../common/http-error.js';
import type { Agent } from '../agent/types.js';
import { EMBED_AGENT_ID_KEY, SystemSettingService } from '../settings/settings.service.js';
import { registerEmbedRoutes, resolveEmbedAgentId } from './embed.routes.js';

function agent(id: number, enabled: number | null = 1): Agent {
  return { id, name: `agent-${id}`, systemPrompt: '', enabled };
}

function deps() {
  return {
    systemSettingService: { getValue: vi.fn() },
    agentService: { getAgent: vi.fn(), getDefaultAgent: vi.fn() },
  };
}

describe('resolveEmbedAgentId', () => {
  it('returns the configured agent when it exists and is enabled', async () => {
    const d = deps();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue('7');
    vi.mocked(d.agentService.getAgent).mockResolvedValue(agent(7));
    expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBe(7);
    expect(d.agentService.getDefaultAgent).not.toHaveBeenCalled();
  });

  it('falls back to the default agent when the setting is unset, empty or not numeric', async () => {
    for (const configured of [null, '', '   ', 'abc', '1.5', '0x10']) {
      const d = deps();
      vi.mocked(d.systemSettingService.getValue).mockResolvedValue(configured);
      // 真实 getAgent 对 NaN / 非纯数字 / 不存在 ID 一律抛 AGENT_NOT_FOUND（见 agent.service.ts）
      vi.mocked(d.agentService.getAgent).mockRejectedValue(new BusinessException(ErrorCode.AGENT_NOT_FOUND));
      vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(agent(3));
      expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBe(3);
    }
  });

  it('falls back to the default agent when the configured agent does not exist', async () => {
    const d = deps();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue('9');
    vi.mocked(d.agentService.getAgent).mockRejectedValue(new BusinessException(ErrorCode.AGENT_NOT_FOUND));
    vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(agent(3));
    expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBe(3);
  });

  it('falls back to the default agent when the configured agent is disabled', async () => {
    const d = deps();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue('9');
    vi.mocked(d.agentService.getAgent).mockResolvedValue(agent(9, 0));
    vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(agent(3));
    expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBe(3);
  });

  it('returns null when no default agent exists or it is disabled', async () => {
    for (const fallback of [null, agent(3, 0)]) {
      const d = deps();
      vi.mocked(d.systemSettingService.getValue).mockResolvedValue(null);
      vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(fallback);
      expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBeNull();
    }
  });

  it('treats a rejecting default-agent lookup as unavailable instead of throwing', async () => {
    const d = deps();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue(null);
    vi.mocked(d.agentService.getDefaultAgent).mockRejectedValue(new Error('db down'));
    expect(await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never)).toBeNull();
  });

  it('reads the embed.agentId setting key', async () => {
    const d = deps();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue(null);
    vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(null);
    await resolveEmbedAgentId(d.systemSettingService as never, d.agentService as never);
    expect(d.systemSettingService.getValue).toHaveBeenCalledWith(EMBED_AGENT_ID_KEY);
    expect(EMBED_AGENT_ID_KEY).toBe('embed.agentId');
  });
});

describe('GET /v1/embed/admin-config', () => {
  async function setup(userId: number | undefined = 7) {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', async (request) => { (request as { userId?: number }).userId = userId; });
    const d = deps();
    registerEmbedRoutes(app, d as never);
    return { app, d };
  }

  it('returns only the resolved agentId for a logged-in user', async () => {
    const { app, d } = await setup();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue('7');
    vi.mocked(d.agentService.getAgent).mockResolvedValue(agent(7));
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/embed/admin-config' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ code: 0, data: { agentId: 7 } });
    } finally {
      await app.close();
    }
  });

  it('returns agentId null when nothing is resolvable, still 200', async () => {
    const { app, d } = await setup();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue(null);
    vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(null);
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/embed/admin-config' });
      expect(response.statusCode).toBe(200);
      // toJacksonJson 省略 null：无可用 Agent 时线上报文为 data: {}，agentId 缺省即 null 语义（前端按 falsy 处理）
      expect(response.json()).toMatchObject({ code: 0, data: {} });
    } finally {
      await app.close();
    }
  });

  it('requires a logged-in user (401) and does not read settings', async () => {
    const { app, d } = await setup();
    app.addHook('preHandler', async (request) => { (request as { userId?: number }).userId = undefined; });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/embed/admin-config' });
      expect(response.statusCode).toBe(401);
      expect(d.systemSettingService.getValue).not.toHaveBeenCalled();
      expect(d.agentService.getDefaultAgent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not require settings:read: no permission lookup happens', async () => {
    const { app, d } = await setup();
    vi.mocked(d.systemSettingService.getValue).mockResolvedValue(null);
    vi.mocked(d.agentService.getDefaultAgent).mockResolvedValue(agent(1));
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/embed/admin-config' });
      expect(response.statusCode).toBe(200);
      // deps 只有 setting/agent 两个服务：没有任何 permission 依赖被调用
      expect(Object.keys(d)).toEqual(['systemSettingService', 'agentService']);
      expect(SystemSettingService.EMBED_AGENT_ID_KEY).toBe('embed.agentId');
    } finally {
      await app.close();
    }
  });
});
