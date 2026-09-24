import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasText } from '../common/case.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import { encryptAesGcm } from '../crypto/aes-gcm.js';
import type { DingtalkBotRuntimeStatus } from './monitor.service.js';
import type { DingtalkBot, DingtalkBotRepository, DingtalkBotView } from './types.js';

export interface DingtalkBotRouteDeps {
  repository: DingtalkBotRepository;
  secretKey: string;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  monitorStatus?: { getStatus(botId: number): DingtalkBotRuntimeStatus | null };
  monitorReconnect?: { reconnect(botId: number): Promise<boolean> };
}

interface DingtalkBotRequest {
  appKey?: string;
  name?: string;
  clientId?: string;
  clientSecret?: string;
  robotCode?: string;
  agentId?: number | null;
  modelId?: number | null;
  progressCardTemplateId?: string | null;
  queueCardTemplateId?: string | null;
  enabled?: boolean | number;
}

export function registerDingtalkBotRoutes(app: FastifyInstance, deps: DingtalkBotRouteDeps): void {
  const { repository, permissionService } = deps;

  app.get('/v1/admin/dingtalk-bots/status', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:read');
    const bots = await repository.list();
    return sendOk(reply, bots.map((bot) => {
      const runtime = bot.id != null ? deps.monitorStatus?.getStatus(bot.id) ?? null : null;
      return {
        botId: bot.id,
        clientId: bot.clientId,
        name: bot.name,
        enabled: bot.enabled,
        status: bot.enabled !== 1 ? 'disabled' : runtime?.status ?? 'disabled',
        lastFailureReason: runtime?.lastFailureReason ?? null,
        lastFailureAt: runtime?.lastFailureAt ?? null,
        lastReadyAt: runtime?.lastReadyAt ?? null,
      };
    }));
  });

  app.get('/v1/admin/dingtalk-bots', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:read');
    return sendOk(reply, (await repository.list()).map(toView));
  });

  app.get('/v1/admin/dingtalk-bots/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:read');
    return sendOk(reply, toView(await requireBot(repository, pathId(request))));
  });

  app.post('/v1/admin/dingtalk-bots', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:write');
    const body = bodyOf<DingtalkBotRequest>(request);
    requireText(body.appKey, 'appKey');
    requireText(body.name, 'name');
    requireText(body.clientId, 'clientId');
    requireText(body.clientSecret, 'clientSecret');
    requireText(body.robotCode, 'robotCode');
    assertSecretKey(deps.secretKey);
    const bot: DingtalkBot = {
      appKey: body.appKey!, name: body.name!, clientId: body.clientId!, robotCode: body.robotCode!,
      clientSecret: encryptAesGcm(body.clientSecret!, deps.secretKey)!,
      agentId: body.agentId ?? null, modelId: body.modelId ?? null,
      progressCardTemplateId: emptyToNull(body.progressCardTemplateId),
      queueCardTemplateId: emptyToNull(body.queueCardTemplateId),
      enabled: enabledValue(body.enabled, 1),
    };
    try {
      await repository.create(bot);
    } catch (error) {
      throw duplicateOr(error);
    }
    return sendOk(reply, toView(bot));
  });

  app.put('/v1/admin/dingtalk-bots/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:write');
    const bot = await requireBot(repository, pathId(request));
    const body = bodyOf<DingtalkBotRequest>(request);
    if (body.appKey != null) requireText(body.appKey, 'appKey');
    if (body.name != null) requireText(body.name, 'name');
    if (body.clientId != null) requireText(body.clientId, 'clientId');
    if (body.robotCode != null) requireText(body.robotCode, 'robotCode');
    bot.appKey = body.appKey ?? bot.appKey;
    bot.name = body.name ?? bot.name;
    bot.clientId = body.clientId ?? bot.clientId;
    bot.robotCode = body.robotCode ?? bot.robotCode;
    if (body.clientSecret != null && body.clientSecret !== '') {
      assertSecretKey(deps.secretKey);
      bot.clientSecret = encryptAesGcm(body.clientSecret, deps.secretKey)!;
    }
    bot.agentId = body.agentId !== undefined ? body.agentId : bot.agentId;
    bot.modelId = body.modelId !== undefined ? body.modelId : bot.modelId;
    if (body.progressCardTemplateId !== undefined) bot.progressCardTemplateId = emptyToNull(body.progressCardTemplateId);
    if (body.queueCardTemplateId !== undefined) bot.queueCardTemplateId = emptyToNull(body.queueCardTemplateId);
    bot.enabled = body.enabled === undefined ? bot.enabled : enabledValue(body.enabled, bot.enabled ?? 1);
    try {
      await repository.update(bot);
    } catch (error) {
      throw duplicateOr(error);
    }
    return sendOk(reply, toView(bot));
  });

  app.delete('/v1/admin/dingtalk-bots/:id', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:write');
    await requireBot(repository, pathId(request));
    await repository.softDelete(pathId(request));
    return sendOk(reply);
  });

  app.post('/v1/admin/dingtalk-bots/:id/enable', async (request, reply) => setEnabled(request, reply, deps, pathId(request), 1));
  app.post('/v1/admin/dingtalk-bots/:id/disable', async (request, reply) => setEnabled(request, reply, deps, pathId(request), 0));

  app.post('/v1/admin/dingtalk-bots/:id/reconnect', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'dingtalk-bot:write');
    const id = pathId(request);
    const bot = await requireBot(repository, id);
    if (bot.enabled !== 1) throw new BusinessException(ErrorCode.PARAM_INVALID, '钉钉机器人已停用，无法重连');
    if (deps.monitorReconnect == null) throw new BusinessException(ErrorCode.INTERNAL_ERROR, '钉钉Bot监控未启用，无法触发重连');
    const scheduled = await deps.monitorReconnect.reconnect(id);
    if (!scheduled) throw new BusinessException(ErrorCode.INTERNAL_ERROR, '钉钉Bot监控未运行，无法触发重连');
    const runtime = deps.monitorStatus?.getStatus(id) ?? null;
    return sendOk(reply, {
      botId: id,
      status: runtime?.status ?? 'reconnecting',
      lastFailureReason: runtime?.lastFailureReason ?? null,
      lastFailureAt: runtime?.lastFailureAt ?? null,
      lastReadyAt: runtime?.lastReadyAt ?? null,
    });
  });
}

async function setEnabled(request: FastifyRequest, reply: FastifyReply, deps: DingtalkBotRouteDeps, id: number, enabled: number): Promise<FastifyReply> {
  await requireRequestPermission(deps.permissionService, request, 'dingtalk-bot:write');
  const bot = await requireBot(deps.repository, id);
  bot.enabled = enabled;
  await deps.repository.update(bot);
  return sendOk(reply, toView(bot));
}

async function requireBot(repository: DingtalkBotRepository, id: number): Promise<DingtalkBot> {
  const bot = await repository.findById(id);
  if (!bot) throw new BusinessException(ErrorCode.PARAM_INVALID, '钉钉机器人不存在');
  return bot;
}

function requireText(value: string | undefined, field: string): void {
  if (!hasText(value)) throw new BusinessException(ErrorCode.PARAM_INVALID, `${field}不能为空`);
}

function assertSecretKey(secretKey: string): void {
  if (!hasText(secretKey)) throw new BusinessException(ErrorCode.PARAM_INVALID, '未配置 APP_DINGTALK_BOT_SECRET');
}

function enabledValue(value: boolean | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  return value === true || value === 1 ? 1 : 0;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null;
  return value.trim();
}

function toView(bot: DingtalkBot): DingtalkBotView {
  const { clientSecret, ...view } = bot;
  return { ...view, clientSecretConfigured: clientSecret.length > 0 };
}

function duplicateOr(error: unknown): unknown {
  const code = error != null && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code) : '';
  if (code === 'ER_DUP_ENTRY') return new BusinessException(ErrorCode.PARAM_INVALID, 'App Key 或 Client ID 已存在');
  return error;
}
