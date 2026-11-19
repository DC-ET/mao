import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerModelRoutes } from './model.routes.js';
import type { ModelService } from './model.service.js';
import type { LlmModel } from './types.js';

function modelFixture(overrides: Partial<LlmModel> = {}): LlmModel {
  return {
    id: 1,
    name: 'gpt-test',
    provider: 'openai',
    baseUrl: 'https://api.example.test',
    apiKey: 'sk-secret',
    modelId: 'gpt-test',
    authType: 'api_key',
    status: 1,
    ...overrides,
  };
}

function buildApp(options: {
  model?: LlmModel;
  permissions?: string[];
  /** undefined = 未注入 ecpEnabled（装配缺失场景）。 */
  ecpEnabled?: boolean;
} = {}) {
  const model = options.model ?? modelFixture();
  const permissions = options.permissions ?? ['model:read', 'model:write'];
  const modelService = {
    getModel: vi.fn(async () => model),
    testConnectivity: vi.fn(async () => ({ connectivity: true, durationMs: 1 })),
    createModel: vi.fn(async () => modelFixture({ authType: 'ecp', apiKey: '' })),
  } as unknown as ModelService;
  const app = Fastify();
  app.setErrorHandler(handleError);
  app.addHook('preHandler', (request, _reply, done) => {
    (request as unknown as { userId: number }).userId = 9;
    done();
  });
  registerModelRoutes(app, {
    modelService,
    permissionService: {
      hasPermission: vi.fn(async (_userId: number, code: string) => permissions.includes(code)),
    },
    ecpEnabled: options.ecpEnabled === undefined
      ? undefined
      : async () => options.ecpEnabled === true,
  });
  return { app, modelService };
}

describe('model routes（凭证方式）', () => {
  it('hides apiKey entirely for ecp models even with reveal permission', async () => {
    const { app } = buildApp({ model: modelFixture({ authType: 'ecp' }) });
    const res = await app.inject({ method: 'GET', url: '/v1/models/1' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as Record<string, unknown>;
    expect(data.authType).toBe('ecp');
    expect(data.apiKey).toBe('');
  });

  it('masks apiKey for readers without model:write on api_key models', async () => {
    const { app } = buildApp({ permissions: ['model:read'] });
    const res = await app.inject({ method: 'GET', url: '/v1/models/1' });
    const data = res.json().data as Record<string, unknown>;
    expect(data.authType).toBe('api_key');
    expect(data.apiKey).toBe('****cret');
  });

  it('returns revealed apiKey for model:write readers on api_key models', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models/1' });
    expect((res.json().data as Record<string, unknown>).apiKey).toBe('sk-secret');
  });

  it('exposes ecp availability as a boolean', async () => {
    const on = buildApp({ ecpEnabled: true });
    const onRes = await on.app.inject({ method: 'GET', url: '/v1/models/ecp-availability' });
    expect(onRes.json().data).toEqual({ enabled: true });

    const off = buildApp({ ecpEnabled: false });
    const offRes = await off.app.inject({ method: 'GET', url: '/v1/models/ecp-availability' });
    expect(offRes.json().data).toEqual({ enabled: false });
  });

  it('fails closed when ecpEnabled dependency is not wired', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models/ecp-availability' });
    expect(res.json().data).toEqual({ enabled: false });
  });

  it('passes the acting admin userId into connectivity test', async () => {
    const { app, modelService } = buildApp();
    const res = await app.inject({ method: 'POST', url: '/v1/models/1/test' });
    expect(res.statusCode).toBe(200);
    expect(modelService.testConnectivity).toHaveBeenCalledWith(1, 9);
  });

  it('create route forwards missing apiKey as empty string for ecp models', async () => {
    const { app, modelService } = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/models',
      payload: { name: 'm', provider: 'p', baseUrl: 'https://x', modelId: 'mid', authType: 'ecp' },
    });
    expect(res.statusCode).toBe(200);
    // createModel(name, provider, baseUrl, apiKey, ...)：路由层必须把缺失 apiKey 兜底为空串（列 NOT NULL）。
    expect(vi.mocked(modelService.createModel).mock.calls[0][3]).toBe('');
  });
});
