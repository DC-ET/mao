import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { hasText } from '../common/case.js';
import { bodyOf, pathParam, queryOptStr } from '../common/request.js';
import { JEV_API_KEY_KEY, JEV_ENDPOINT_KEY, JEV_MODEL_KEY, type SystemSettingService } from './settings.service.js';
import { defaultFeishuHttp } from '../auth/feishu-auth.service.js';
import {
  defaultJevHttp, defaultLdapClientFactory, defaultStorageProbeHttp, mergeWithDefaults, testFeishuCredentials, testJevConnection, testLdapConnection, testObjectStorageProbe, testSmtpConnection,
  type EmailTestSender,
} from './settings-test.service.js';
import { EmailWebhookSender } from '../notification/task/email-sender.js';
import type { EmailSmtpSettings } from './types.js';
import { signCosRequest, signObsRequest, signOssRequest } from '../upload/storage-signer.js';

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
  /**
   * 容器域名解析预览（Docker 模式）：返回生效条目（宿主继承 ∪ 自定义，含来源标记）。
   * 由 ContainerHostsResolver.preview 提供；未注入时不注册该接口。
   */
  containerHostsPreview?: () => Promise<{
    inheritEnabled: boolean;
    hostsFilePath: string;
    hostsFileError: string | null;
    entries: Array<{ host: string; ip: string; source: 'hosts-file' | 'custom' }>;
  }>;
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

  // 管理后台菜单可见性（部署级全局配置）：仅要求登录，不要求 settings:read——
  // 没有设置读权限的运营角色也要按部署配置过滤侧栏菜单。只暴露隐藏路径列表，不透出其它配置值。
  app.get('/v1/system-settings/menu-visibility', async (request, reply) => {
    requireUserId(request);
    return sendOk(reply, { hidden: await systemSettingService.getAdminMenuHidden() });
  });

  // 容器域名解析生效条目预览（管理后台「运行环境」面板只读展示）。
  // 仅 settings:read；未注入 resolver（如纯 host 部署的测试环境）时接口不存在。
  if (deps.containerHostsPreview) {
    app.get('/v1/system-settings/container-hosts/preview', async (request, reply) => {
      const userId = requireUserId(request);
      await requirePermission(permissionService, userId, 'settings:read');
      return sendOk(reply, await deps.containerHostsPreview!());
    });
  }

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

  // 三家对象存储连通性测试（多云预签名直传）：表单 overrides 与已存配置合并，可测未保存的修改。
  // 探针 = 对 uploads/.mao-probe 真实预签名 PUT + DELETE 清理，验证凭证与 bucket 写权限。
  app.post('/v1/system-settings/test/oss', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const overrides = bodyOf<Partial<{ region: string; accessKeyId: string; accessKeySecret: string; bucket: string }>>(request);
    const stored = (await systemSettingService.getOssConfig()) ?? { region: '', accessKeyId: '', accessKeySecret: '', bucket: '' };
    const merged = mergeWithDefaults(overrides, stored);
    await testObjectStorageProbe('阿里云 OSS', [
      ['Region', merged.region], ['AccessKey ID', merged.accessKeyId],
      ['AccessKey Secret', merged.accessKeySecret], ['Bucket', merged.bucket],
    ], {
      // OSS 的 Content-Type 参与签名：探针 PUT 带 text/plain 头，签名时必须带同一值
      sign: (key, expires, method, contentType) => signOssRequest(merged, method, key, expires, Date.now(), contentType).uploadUrl,
    }, defaultStorageProbeHttp());
    return sendOk(reply, { ok: true });
  });

  app.post('/v1/system-settings/test/cos', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const overrides = bodyOf<Partial<{ region: string; secretId: string; secretKey: string; bucket: string }>>(request);
    const stored = (await systemSettingService.getCosConfig()) ?? { region: '', secretId: '', secretKey: '', bucket: '' };
    const merged = mergeWithDefaults(overrides, stored);
    await testObjectStorageProbe('腾讯云 COS', [
      ['Region', merged.region], ['SecretId', merged.secretId],
      ['SecretKey', merged.secretKey], ['Bucket', merged.bucket],
    ], {
      sign: (key, expires, method) => signCosRequest(merged, method, key, expires, Date.now()).uploadUrl,
    }, defaultStorageProbeHttp());
    return sendOk(reply, { ok: true });
  });

  app.post('/v1/system-settings/test/obs', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const overrides = bodyOf<Partial<{ endpoint: string; accessKeyId: string; accessKeySecret: string; bucket: string }>>(request);
    const stored = (await systemSettingService.getObsConfig()) ?? { endpoint: '', accessKeyId: '', accessKeySecret: '', bucket: '' };
    const merged = mergeWithDefaults(overrides, stored);
    await testObjectStorageProbe('华为云 OBS', [
      ['Endpoint', merged.endpoint], ['AccessKey ID', merged.accessKeyId],
      ['AccessKey Secret', merged.accessKeySecret], ['Bucket', merged.bucket],
    ], {
      // OBS 的 Content-Type 参与签名：探针 PUT 带 text/plain 头，签名时必须带同一值
      sign: (key, expires, method, contentType) => signObsRequest(merged, method, key, expires, Date.now(), contentType || 'text/plain').uploadUrl,
    }, defaultStorageProbeHttp());
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
