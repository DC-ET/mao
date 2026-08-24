import type { FastifyInstance } from 'fastify';
import type { ClientImpersonation } from '@mao/contracts';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import type { ModelService } from './model.service.js';
import type { LlmModel, ModelVO } from './types.js';

export interface ModelRouteDeps {
  modelService: ModelService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface CreateModelRequest {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  modelType?: string;
  clientImpersonation?: string;
  contextWindowTokens?: number;
  supportsVision?: number;
  isDefault?: number;
}

interface UpdateStatusRequest {
  status?: number;
}

export function registerModelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const { modelService, permissionService } = deps;

  async function revealApiKey(request: Parameters<typeof requireUserId>[0]): Promise<boolean> {
    const userId = requireUserId(request);
    return permissionService.hasPermission(userId, 'model:write');
  }

  async function requireModelWrite(request: Parameters<typeof requireUserId>[0]): Promise<void> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'model:write');
  }

  app.get('/v1/models', async (request, reply) => {
    const reveal = await revealApiKey(request);
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 10);
    const result = await modelService.listModels(
      page,
      size,
      queryOptStr(request, 'keyword'),
      queryOptStr(request, 'provider'),
      queryOptInt(request, 'status'),
      queryOptInt(request, 'supportsVision'),
      queryOptInt(request, 'isDefault'),
      queryOptStr(request, 'modelType'),
    );
    return sendOk(reply, {
      records: result.records.map((m) => toVO(m, reveal)),
      total: result.total,
      page: result.page,
      size: result.size,
    });
  });

  app.get('/v1/models/active', async (request, reply) => {
    const reveal = await revealApiKey(request);
    const list = (await modelService.listActiveModels()).map((m) => toVO(m, reveal));
    return sendOk(reply, list);
  });

  app.get('/v1/models/providers', async (request, reply) => {
    requireUserId(request);
    return sendOk(reply, await modelService.listProviders());
  });

  app.get('/v1/models/default', async (request, reply) => {
    const reveal = await revealApiKey(request);
    const model = await modelService.getDefaultModel();
    return sendOk(reply, model != null ? toVO(model, reveal) : undefined);
  });

  app.get('/v1/models/:id', async (request, reply) => {
    const reveal = await revealApiKey(request);
    return sendOk(reply, toVO(await modelService.getModel(pathId(request)), reveal));
  });

  app.post('/v1/models', async (request, reply) => {
    await requireModelWrite(request);
    const body = bodyOf<CreateModelRequest>(request);
    const model = await modelService.createModel(
      body.name!,
      body.provider,
      body.baseUrl!,
      body.apiKey!,
      body.modelId!,
      body.supportsVision,
      body.isDefault,
      body.contextWindowTokens,
      body.modelType,
      body.clientImpersonation,
    );
    return sendOk(reply, toVO(model, true));
  });

  app.put('/v1/models/:id', async (request, reply) => {
    await requireModelWrite(request);
    const body = bodyOf<CreateModelRequest>(request);
    const model = await modelService.updateModel(
      pathId(request),
      body.name,
      body.provider,
      body.baseUrl,
      body.apiKey,
      body.modelId,
      body.supportsVision,
      body.isDefault,
      body.contextWindowTokens,
      body.modelType,
      body.clientImpersonation,
    );
    return sendOk(reply, toVO(model, true));
  });

  app.delete('/v1/models/:id', async (request, reply) => {
    await requireModelWrite(request);
    await modelService.deleteModel(pathId(request));
    return sendOk(reply);
  });

  app.patch('/v1/models/:id/status', async (request, reply) => {
    await requireModelWrite(request);
    const body = bodyOf<UpdateStatusRequest>(request);
    await modelService.updateStatus(pathId(request), body.status);
    return sendOk(reply);
  });

  app.post('/v1/models/:id/test', async (request, reply) => {
    await requireModelWrite(request);
    return sendOk(reply, await modelService.testConnectivity(pathId(request)));
  });
}

function maskApiKey(apiKey: string | null | undefined): string {
  if (apiKey == null || apiKey.length === 0) return '';
  if (apiKey.length <= 4) return '****';
  return `****${apiKey.slice(-4)}`;
}

function toVO(entity: LlmModel, revealApiKey: boolean): ModelVO {
  return {
    id: entity.id,
    name: entity.name,
    provider: entity.provider,
    baseUrl: entity.baseUrl,
    apiKey: revealApiKey ? entity.apiKey : maskApiKey(entity.apiKey),
    modelId: entity.modelId,
    modelType: entity.modelType,
    clientImpersonation: normalizeVoClientImpersonation(entity.clientImpersonation),
    contextWindowTokens: entity.contextWindowTokens,
    supportsVision: entity.supportsVision != null && entity.supportsVision === 1,
    isDefault: entity.isDefault != null && entity.isDefault === 1,
    status: entity.status,
    createdAt: entity.createdAt ?? null,
  };
}

function normalizeVoClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}
