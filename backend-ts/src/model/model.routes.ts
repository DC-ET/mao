import type { FastifyInstance } from 'fastify';
import type { ClientImpersonation, FeaturedModelOption } from '@mao/contracts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
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
  isDefault?: number | boolean;
  /** 客户端可选：缺省/未传=创建可见、更新保持原值；false/0=仅管理端可配置。 */
  clientVisible?: number | boolean | null;
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
      queryOptInt(request, 'clientVisible'),
    );
    return sendOk(reply, {
      records: result.records.map((m) => toVO(m, reveal)),
      total: result.total,
      page: result.page,
      size: result.size,
    });
  });

  app.get('/v1/models/active', async (request, reply) => {
    // scope=client：客户端模型选择器用，只看 client_visible = 1；
    // 不带 scope 保持全量（管理后台 Agent 默认模型/机器人配置必须能选到隐藏模型）。
    const scope = queryOptStr(request, 'scope');
    if (scope != null && scope !== 'client') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, "scope 仅支持 'client'");
    }
    const reveal = await revealApiKey(request);
    const list = (await modelService.listActiveModels(scope === 'client')).map((m) => toVO(m, reveal));
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

  // Agent 特色工具可用性（技术方案 2026-11-27 §5.3.2 + 默认模型/Agent 指定模型）：只返回布尔、
// 模型名与候选列表（id / name / isDefault），不返回 key / baseUrl。
// 登录即可，不要求 model:read（Agent 管理员不一定有模型权限）。
  app.get('/v1/models/availability', async (request, reply) => {
    requireUserId(request);
    const [image, audio, options] = await Promise.all([
      modelService.findFirstActiveImageModel(),
      modelService.findFirstActiveAudioModel(),
      modelService.listFeaturedModelOptions(),
    ]);
    return sendOk(reply, {
      image: {
        available: image != null,
        modelName: image?.name ?? null,
        models: toFeaturedOptions(options.image),
      },
      audio: {
        available: audio != null,
        modelName: audio?.name ?? null,
        models: toFeaturedOptions(options.audio),
      },
    });
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
      body.clientVisible,
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
      body.clientVisible,
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
    clientVisible: entity.clientVisible !== 0,
    createdAt: entity.createdAt ?? null,
  };
}

function normalizeVoClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}

/** 特色工具候选（2026-11-27）：最小暴露 id / name / isDefault；默认模型在前，其余按 id ASC。 */
function toFeaturedOptions(models: LlmModel[]): FeaturedModelOption[] {
  return models
    .filter((m) => m.id != null)
    .map((m) => ({ id: m.id!, name: m.name, isDefault: m.isDefault === 1 }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id - b.id);
}
