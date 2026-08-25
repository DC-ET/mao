import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireAdmin, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import { encryptAesGcm } from '../crypto/aes-gcm.js';
import type { FeishuBot, FeishuBotRepository, FeishuBotView } from './types.js';

export interface FeishuBotRouteDeps {
  repository: FeishuBotRepository;
  secretKey: string;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
}

interface FeishuBotRequest {
  appKey?: string;
  name?: string;
  appId?: string;
  appSecret?: string;
  agentId?: number | null;
  modelId?: number | null;
  enabled?: boolean | number;
}

export function registerFeishuBotRoutes(app: FastifyInstance, deps: FeishuBotRouteDeps): void {
  const { repository, permissionService } = deps;

  app.get('/v1/admin/feishu-bots', async (request, reply) => {
    await requireAdmin(permissionService, request);
    return sendOk(reply, (await repository.list()).map(toView));
  });

  app.get('/v1/admin/feishu-bots/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const bot = await requireBot(repository, pathId(request));
    return sendOk(reply, toView(bot));
  });

  app.post('/v1/admin/feishu-bots', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const body = bodyOf<FeishuBotRequest>(request);
    requireText(body.appKey, 'appKey');
    requireText(body.name, 'name');
    requireText(body.appId, 'appId');
    requireText(body.appSecret, 'appSecret');
    if (!hasText(deps.secretKey)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '后端未配置 APP_FEISHU_BOT_SECRET，无法加密存储 app_secret，请先配置');
    }
    const bot: FeishuBot = {
      appKey: body.appKey!, name: body.name!, appId: body.appId!,
      appSecret: encryptAesGcm(body.appSecret!, deps.secretKey)!,
      agentId: body.agentId ?? null, modelId: body.modelId ?? null,
      enabled: enabledValue(body.enabled, 1),
    };
    await repository.create(bot);
    return sendOk(reply, toView(bot));
  });

  app.put('/v1/admin/feishu-bots/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    const bot = await requireBot(repository, pathId(request));
    const body = bodyOf<FeishuBotRequest>(request);
    if (body.appKey != null) requireText(body.appKey, 'appKey');
    if (body.name != null) requireText(body.name, 'name');
    if (body.appId != null) requireText(body.appId, 'appId');
    bot.appKey = body.appKey ?? bot.appKey;
    bot.name = body.name ?? bot.name;
    bot.appId = body.appId ?? bot.appId;
    if (body.appSecret != null && body.appSecret !== '') {
      if (!hasText(deps.secretKey)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '后端未配置 APP_FEISHU_BOT_SECRET，无法加密存储 app_secret，请先配置');
      }
      bot.appSecret = encryptAesGcm(body.appSecret, deps.secretKey)!;
    }
    bot.agentId = body.agentId !== undefined ? body.agentId : bot.agentId;
    bot.modelId = body.modelId !== undefined ? body.modelId : bot.modelId;
    bot.enabled = body.enabled === undefined ? bot.enabled : enabledValue(body.enabled, bot.enabled ?? 1);
    await repository.update(bot);
    return sendOk(reply, toView(bot));
  });

  app.delete('/v1/admin/feishu-bots/:id', async (request, reply) => {
    await requireAdmin(permissionService, request);
    await requireBot(repository, pathId(request));
    await repository.softDelete(pathId(request));
    return sendOk(reply);
  });

  app.post('/v1/admin/feishu-bots/:id/enable', async (request, reply) => {
    return setEnabled(request, reply, repository, permissionService, pathId(request), 1);
  });

  app.post('/v1/admin/feishu-bots/:id/disable', async (request, reply) => {
    return setEnabled(request, reply, repository, permissionService, pathId(request), 0);
  });
}

async function setEnabled(
  request: FastifyRequest,
  reply: FastifyReply,
  repository: FeishuBotRepository,
  permissionService: FeishuBotRouteDeps['permissionService'],
  id: number,
  enabled: number,
): Promise<FastifyReply> {
  await requireAdmin(permissionService, request);
  const bot = await requireBot(repository, id);
  bot.enabled = enabled;
  await repository.update(bot);
  return sendOk(reply, toView(bot));
}

async function requireBot(repository: FeishuBotRepository, id: number): Promise<FeishuBot> {
  const bot = await repository.findById(id);
  if (!bot) throw new BusinessException(ErrorCode.PARAM_INVALID, '飞书机器人不存在');
  return bot;
}

function requireText(value: string | undefined, field: string): void {
  if (!hasText(value)) throw new BusinessException(ErrorCode.PARAM_INVALID, `${field}不能为空`);
}

function enabledValue(value: boolean | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return value === true || value === 1 ? 1 : 0;
}

function toView(bot: FeishuBot): FeishuBotView {
  const { appSecret, ...view } = bot;
  return { ...view, appSecretConfigured: appSecret.length > 0 };
}
