import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
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
  /** true = 不注入登录态（校验未登录分支）。 */
  unauthenticated?: boolean;
} = {}) {
  const model = options.model ?? modelFixture();
  const permissions = options.permissions ?? ['model:read', 'model:write'];
  const modelService = {
    getModel: vi.fn(async () => model),
    testConnectivity: vi.fn(async () => ({ connectivity: true, durationMs: 1 })),
    createModel: vi.fn(async () => modelFixture({ authType: 'ecp', apiKey: '' })),
    findFirstActiveImageModel: vi.fn(async () => model),
    findFirstActiveAudioModel: vi.fn(async () => null),
    listFeaturedModelOptions: vi.fn(async () => ({
      image: [modelFixture({ id: 18, name: 'Flux Pro', isDefault: 0 }), modelFixture({ id: 12, name: 'GPT image 2', isDefault: 1 })],
      audio: [],
    })),
  } as unknown as ModelService;
  const app = Fastify();
  app.setErrorHandler(handleError);
  if (options.unauthenticated !== true) {
    app.addHook('preHandler', (request, _reply, done) => {
      (request as unknown as { userId: number }).userId = 9;
      done();
    });
  }
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

describe('model routes（客户端可选）', () => {
  function buildVisibilityApp(clientVisible: number | null | undefined) {
    const model = modelFixture(clientVisible == null ? {} : { clientVisible });
    const modelService = {
      listActiveModels: vi.fn(async () => [model]),
      listModels: vi.fn(async () => ({ records: [model], total: 1, page: 1, size: 10 })),
      getModel: vi.fn(async () => model),
      createModel: vi.fn(async () => model),
      updateModel: vi.fn(async () => model),
    } as unknown as ModelService;
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (request, _reply, done) => {
      (request as unknown as { userId: number }).userId = 9;
      done();
    });
    registerModelRoutes(app, {
      modelService,
      permissionService: { hasPermission: vi.fn(async () => true) },
    });
    return { app, modelService };
  }

  it('GET /models/active：不带 scope 取全量，scope=client 只看可见', async () => {
    const { app, modelService } = buildVisibilityApp(1);
    expect((await app.inject({ method: 'GET', url: '/v1/models/active' })).statusCode).toBe(200);
    expect(modelService.listActiveModels).toHaveBeenLastCalledWith(false);

    expect((await app.inject({ method: 'GET', url: '/v1/models/active?scope=client' })).statusCode).toBe(200);
    expect(modelService.listActiveModels).toHaveBeenLastCalledWith(true);
  });

  it('GET /models/active：非法 scope 返回参数错误（Mao 约定 HTTP 200 + 业务 code）', async () => {
    const { app } = buildVisibilityApp(1);
    const res = await app.inject({ method: 'GET', url: '/v1/models/active?scope=admin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(res.json().message).toContain("scope 仅支持 'client'");
  });

  it('GET /models：clientVisible 作为筛选参数透传', async () => {
    const { app, modelService } = buildVisibilityApp(0);
    const res = await app.inject({ method: 'GET', url: '/v1/models?page=1&size=10&clientVisible=0' });
    expect(res.statusCode).toBe(200);
    expect(modelService.listModels).toHaveBeenCalledWith(
      1, 10, undefined, undefined, undefined, undefined, undefined, undefined, 0,
    );
  });

  it('VO 输出 clientVisible：0 → false，缺省 → true', async () => {
    const hidden = await buildVisibilityApp(0).app.inject({ method: 'GET', url: '/v1/models/1' });
    expect((hidden.json().data as Record<string, unknown>).clientVisible).toBe(false);
    const visible = await buildVisibilityApp(undefined).app.inject({ method: 'GET', url: '/v1/models/1' });
    expect((visible.json().data as Record<string, unknown>).clientVisible).toBe(true);
  });

  it('GET /models/availability：返回布尔、模型名与候选列表（默认在前、最小暴露）', async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: 'GET', url: '/v1/models/availability' });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      image: {
        available: boolean;
        modelName?: string | null;
        models: Array<{ id: number; name: string; isDefault: boolean } & Record<string, unknown>>;
      };
      audio: { available: boolean; modelName?: string | null; models: unknown[] };
    };
    // 旧字段保持：available + modelName 语义不变
    expect(data.image.available).toBe(true);
    expect(data.image.modelName).toBe('gpt-test');
    expect(data.audio.available).toBe(false);
    expect(data.audio.modelName ?? null).toBeNull();
    // models：默认模型在前，其余按 id ASC
    expect(data.image.models.map((m) => m.id)).toEqual([12, 18]);
    expect(data.image.models[0]).toMatchObject({ id: 12, name: 'GPT image 2', isDefault: true });
    // 最小暴露：候选列表不携带 key / baseUrl / 协议等敏感或冗余字段
    expect(data.image.models[0]).not.toHaveProperty('apiKey');
    expect(data.image.models[0]).not.toHaveProperty('baseUrl');
    expect(data.audio.models).toEqual([]);
  });

  it('GET /models/availability：未登录返回 UNAUTHORIZED', async () => {
    const { app } = buildApp({ unauthenticated: true });
    const res = await app.inject({ method: 'GET', url: '/v1/models/availability' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe(ErrorCode.UNAUTHORIZED.code);
  });
});
