import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import type { ModelService } from './model.service.js';
import type { LlmModel, ModelVO } from './types.js';

export interface ModelRouteDeps {
  modelService: ModelService;
}

interface CreateModelRequest {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  modelType?: string;
  contextWindowTokens?: number;
  supportsVision?: number;
  isDefault?: number;
}

interface UpdateStatusRequest {
  status?: number;
}

export function registerModelRoutes(app: FastifyInstance, deps: ModelRouteDeps): void {
  const { modelService } = deps;

  app.get('/v1/models', async (request, reply) => {
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
      records: result.records.map(toVO),
      total: result.total,
      page: result.page,
      size: result.size,
    });
  });

  app.get('/v1/models/active', async (_request, reply) => {
    const list = (await modelService.listActiveModels()).map(toVO);
    return sendOk(reply, list);
  });

  app.get('/v1/models/providers', async (_request, reply) => {
    return sendOk(reply, await modelService.listProviders());
  });

  app.get('/v1/models/default', async (_request, reply) => {
    const model = await modelService.getDefaultModel();
    return sendOk(reply, model != null ? toVO(model) : undefined);
  });

  app.get('/v1/models/:id', async (request, reply) => {
    return sendOk(reply, toVO(await modelService.getModel(pathId(request))));
  });

  app.post('/v1/models', async (request, reply) => {
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
    );
    return sendOk(reply, toVO(model));
  });

  app.put('/v1/models/:id', async (request, reply) => {
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
    );
    return sendOk(reply, toVO(model));
  });

  app.delete('/v1/models/:id', async (request, reply) => {
    await modelService.deleteModel(pathId(request));
    return sendOk(reply);
  });

  app.patch('/v1/models/:id/status', async (request, reply) => {
    const body = bodyOf<UpdateStatusRequest>(request);
    await modelService.updateStatus(pathId(request), body.status);
    return sendOk(reply);
  });

  app.post('/v1/models/:id/test', async (request, reply) => {
    return sendOk(reply, await modelService.testConnectivity(pathId(request)));
  });
}

function toVO(entity: LlmModel): ModelVO {
  return {
    id: entity.id,
    name: entity.name,
    provider: entity.provider,
    baseUrl: entity.baseUrl,
    apiKey: entity.apiKey,
    modelId: entity.modelId,
    modelType: entity.modelType,
    contextWindowTokens: entity.contextWindowTokens,
    supportsVision: entity.supportsVision != null && entity.supportsVision === 1,
    isDefault: entity.isDefault != null && entity.isDefault === 1,
    status: entity.status,
    createdAt: entity.createdAt ?? null,
  };
}
