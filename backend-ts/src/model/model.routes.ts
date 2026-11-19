import type { FastifyInstance } from 'fastify';
import type { ClientImpersonation } from '@mao/contracts';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import { parsePriceColumn } from '../usage/cost-micros.js';
import { normalizeModelAuthType } from './types.js';
import type { ModelService } from './model.service.js';
import type { LlmModel, ModelVO } from './types.js';

export interface ModelRouteDeps {
  modelService: ModelService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  /** ECP 登录开关（auth.ecp.config 的 enabled && appCode && baseUrl）：模型表单据此决定 ECP 选项是否可选。 */
  ecpEnabled?: () => Promise<boolean>;
}

interface CreateModelRequest {
  name?: string;
  provider?: string;
  apiProtocol?: string;
  effort?: string;
  baseUrl?: string;
  apiKey?: string;
  modelId?: string;
  modelType?: string;
  clientImpersonation?: string;
  /** 凭证方式：api_key（缺省） / ecp（当前用户 ECP Token，要求 ECP 登录已启用）。 */
  authType?: string;
  contextWindowTokens?: number;
  maxRequestBodyBytes?: number | null;
  priceInput?: number | null;
  priceCacheRead?: number | null;
  priceCacheWrite?: number | null;
  priceOutput?: number | null;
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

  // 模型表单「凭证方式」可用性：仅暴露布尔，不要求 settings:read（模型编辑者只需 model:write）。
  app.get('/v1/models/ecp-availability', async (request, reply) => {
    requireUserId(request);
    const enabled = deps.ecpEnabled != null ? await deps.ecpEnabled().catch(() => false) : false;
    return sendOk(reply, { enabled });
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
      body.apiKey ?? '',
      body.modelId!,
      body.supportsVision,
      body.isDefault,
      body.contextWindowTokens,
      body.modelType,
      body.clientImpersonation,
      body.apiProtocol,
      body.effort,
      body.priceInput,
      body.priceCacheRead,
      body.priceCacheWrite,
      body.priceOutput,
      body.maxRequestBodyBytes,
      body.authType,
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
      body.apiProtocol,
      body.effort,
      body.priceInput,
      body.priceCacheRead,
      body.priceCacheWrite,
      body.priceOutput,
      body.maxRequestBodyBytes,
      body.authType,
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
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'model:write');
    // 凭证方式为 ecp 时用「发起测试的管理员本人」的 ECP Token（无有效票则返回可读错误）。
    return sendOk(reply, await modelService.testConnectivity(pathId(request), userId));
  });
}

function maskApiKey(apiKey: string | null | undefined): string {
  if (apiKey == null || apiKey.length === 0) return '';
  if (apiKey.length <= 4) return '****';
  return `****${apiKey.slice(-4)}`;
}

function toVO(entity: LlmModel, revealApiKey: boolean): ModelVO {
  const authType = normalizeModelAuthType(entity.authType);
  return {
    id: entity.id,
    name: entity.name,
    provider: entity.provider,
    apiProtocol: entity.apiProtocol,
    effort: entity.effort,
    baseUrl: entity.baseUrl,
    // ecp 模式不含固定 Key 语义：无论 reveal 与否都返回空串，避免管理员误读为仍在使用的 Key。
    apiKey: authType === 'ecp' ? '' : (revealApiKey ? entity.apiKey : maskApiKey(entity.apiKey)),
    modelId: entity.modelId,
    modelType: entity.modelType,
    clientImpersonation: normalizeVoClientImpersonation(entity.clientImpersonation),
    authType,
    contextWindowTokens: entity.contextWindowTokens,
    maxRequestBodyBytes: entity.maxRequestBodyBytes ?? null,
    priceInput: parsePriceColumn(entity.priceInput),
    priceCacheRead: parsePriceColumn(entity.priceCacheRead),
    priceCacheWrite: parsePriceColumn(entity.priceCacheWrite),
    priceOutput: parsePriceColumn(entity.priceOutput),
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
