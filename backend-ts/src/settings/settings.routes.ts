import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { hasText } from '../common/case.js';
import { bodyOf, pathParam, queryOptStr } from '../common/request.js';
import { JEV_API_KEY_KEY, JEV_ENDPOINT_KEY, JEV_MODEL_KEY, type SystemSettingService } from './settings.service.js';
import { defaultFeishuHttp } from '../auth/feishu-auth.service.js';
import {
  defaultJevHttp, defaultLdapClientFactory, mergeWithDefaults, testFeishuCredentials, testJevConnection, testLdapConnection, testOssCredentials, testSmtpConnection,
  type EmailTestSender,
} from './settings-test.service.js';
import { EmailWebhookSender } from '../notification/task/email-sender.js';
import type { EmailSmtpSettings } from './types.js';

export interface SystemSettingRouteDeps {
  systemSettingService: SystemSettingService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  /** 当前管理员资料邮箱查询（test/smtp 发测试信到管理员本人）。 */
  adminEmailLookup: { findEmailById(userId: number): Promise<string | null> };
  /**
   * 保存前校验（items 已是最终待写入值，secret 未修改时为 null）：
   * 抛错则整次保存失败、DB 不变。当前用于 runtime.mode=docker 的容器运行时预检。
   */
  beforeSave?: (items: Array<{ key: string; value: string | null }>) => Promise<void>;
  /** 保存成功后回调（例如失效运行时模式解析缓存，让后台切换立即生效）。 */
  afterSave?: (keys: string[]) => void;
}

interface UpdateSettingRequest {
  value?: string | null;
}

interface BatchUpdateRequest {
  items?: Array<{ key?: string; value?: string | null }>;
}

export { registerSystemSettingRoutes as registerSettingsRoutes };

export function registerSystemSettingRoutes(app: FastifyInstance, deps: SystemSettingRouteDeps): void {
  const { systemSettingService, permissionService } = deps;


  app.get('/v1/system-settings', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:read');
    return sendOk(reply, await systemSettingService.list(queryOptStr(request, 'category') ?? null));
  });

  app.put('/v1/system-settings/batch', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const body = bodyOf<BatchUpdateRequest>(request);
    const items = (body.items ?? []).map((item) => ({ key: String(item.key ?? ''), value: item.value ?? null }));
    await deps.beforeSave?.(items);
    const result = await systemSettingService.updateBatch(items);
    deps.afterSave?.(items.map((item) => item.key));
    return sendOk(reply, result);
  });

  app.put('/v1/system-settings/:key', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const body = bodyOf<UpdateSettingRequest>(request);
    const key = pathParam(request, 'key');
    await deps.beforeSave?.([{ key, value: body.value ?? null }]);
    const result = await systemSettingService.update(key, body.value);
    deps.afterSave?.([key]);
    return sendOk(reply, result);
  });

  app.post('/v1/system-settings/test/ldap', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const overrides = bodyOf<Partial<{ url: string; baseDn: string; userDn: string; password: string; userSearchBase: string }>>(request);
    const stored = await systemSettingService.getLdapConfig();
    const merged = mergeWithDefaults({ ...overrides, enabled: true }, stored);
    await testLdapConnection(merged, defaultLdapClientFactory());
    return sendOk(reply, { ok: true });
  });

  app.post('/v1/system-settings/test/feishu', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const overrides = bodyOf<Partial<{ appId: string; appSecret: string }>>(request);
    const stored = await systemSettingService.getFeishuOAuthConfig();
    const merged = mergeWithDefaults(overrides, stored);
    await testFeishuCredentials(merged.appId, merged.appSecret, defaultFeishuHttp());
    return sendOk(reply, { ok: true });
  });

  app.post('/v1/system-settings/test/oss', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    // 表单 overrides 与已存配置合并：留空（null/undefined）= 回落已存值，可测未保存的修改
    const overrides = bodyOf<Partial<{
      region: string; accessKeyId: string; accessKeySecret: string; bucket: string;
      stsRegionId: string; stsEndpoint: string; stsAccessKeyId: string; stsAccessKeySecret: string; stsRoleArn: string;
    }>>(request);
    const stored = (await systemSettingService.getOssConfig()) ?? {
      region: '', accessKeyId: '', accessKeySecret: '', bucket: '',
      sts: { regionId: '', endpoint: '', accessKeyId: '', accessKeySecret: '', roleArn: '', roleSessionName: 'mao-sts', expire: 3600, maxSizeMb: 50 },
    };
    // mergeWithDefaults 是浅合并：sts 需在此处按字段回落已存值，仅覆盖表单非空项
    const stsMerged = {
      ...stored.sts,
      ...(hasText(overrides.stsRegionId) ? { regionId: overrides.stsRegionId } : {}),
      ...(hasText(overrides.stsEndpoint) ? { endpoint: overrides.stsEndpoint } : {}),
      ...(hasText(overrides.stsAccessKeyId) ? { accessKeyId: overrides.stsAccessKeyId } : {}),
      ...(hasText(overrides.stsAccessKeySecret) ? { accessKeySecret: overrides.stsAccessKeySecret } : {}),
      ...(hasText(overrides.stsRoleArn) ? { roleArn: overrides.stsRoleArn } : {}),
    };
    const merged = mergeWithDefaults({
      region: overrides.region,
      accessKeyId: overrides.accessKeyId,
      accessKeySecret: overrides.accessKeySecret,
      bucket: overrides.bucket,
      sts: stsMerged,
    }, stored);
    await testOssCredentials(merged, async (sts) => {
      const { createAliyunAssumeRoleClient } = await import('../oss/oss-sts.service.js');
      return createAliyunAssumeRoleClient(sts);
    });
    return sendOk(reply, { ok: true });
  });

  app.post('/v1/system-settings/test/jev', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    // 表单留空回落已存值，可在保存前验证未落库的端点 / 模型名 / API Key
    const overrides = bodyOf<Partial<{ endpoint: string; model: string; apiKey: string }>>(request);
    const stored = {
      endpoint: (await systemSettingService.getValue(JEV_ENDPOINT_KEY)) ?? '',
      model: (await systemSettingService.getValue(JEV_MODEL_KEY)) ?? '',
      apiKey: await systemSettingService.getSecretValue(JEV_API_KEY_KEY),
    };
    const merged = mergeWithDefaults({
      endpoint: overrides.endpoint,
      model: overrides.model,
      apiKey: overrides.apiKey,
    }, stored);
    const result = await testJevConnection(merged, defaultJevHttp());
    return sendOk(reply, { ok: true, model: result.model, probability: result.probability });
  });

  app.post('/v1/system-settings/test/smtp', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    // 表单 overrides 与已存配置合并（留空回落已存值），可在保存前验证未落库的 SMTP 配置；
    // enabled 强制置 true：未启用的实例也要能先测通再开启。
    const overrides = bodyOf<Partial<{
      smtpHost: string; smtpPort: string; smtpSecure: string; smtpUser: string; smtpPassword: string; fromAddr: string;
    }>>(request);
    const stored = await systemSettingService.getEmailSmtpConfig();
    const merged: EmailSmtpSettings = {
      ...stored,
      enabled: true,
      ...(hasText(overrides.smtpHost) ? { smtpHost: overrides.smtpHost!.trim() } : {}),
      ...(hasText(overrides.smtpPort) ? { smtpPort: Number(overrides.smtpPort) } : {}),
      ...(hasText(overrides.smtpSecure) ? { useTls: overrides.smtpSecure === 'true' || overrides.smtpSecure === '1' } : {}),
      ...(hasText(overrides.smtpUser) ? { smtpUser: overrides.smtpUser!.trim() } : {}),
      ...(hasText(overrides.smtpPassword) ? { smtpPassword: overrides.smtpPassword! } : {}),
      ...(hasText(overrides.fromAddr) ? { fromAddr: overrides.fromAddr!.trim() } : {}),
    };
    // 测试信只发当前管理员本人（决策 8）：管理员未填邮箱时拒绝并提示
    const toEmail = await deps.adminEmailLookup.findEmailById(userId);
    const sender: EmailTestSender = {
      send: (to, message) => new EmailWebhookSender({ getEmailSmtpConfig: async () => merged }).send(to, message),
    };
    await testSmtpConnection(merged, toEmail ?? '', sender);
    return sendOk(reply, { ok: true });
  });
}
