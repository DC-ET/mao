import type { FastifyInstance } from 'fastify';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { hasText } from '../common/case.js';
import { bodyOf, pathParam, queryOptStr } from '../common/request.js';
import type { SystemSettingService } from './settings.service.js';
import { defaultFeishuHttp } from '../auth/feishu-auth.service.js';
import {
  defaultLdapClientFactory, mergeWithDefaults, testFeishuCredentials, testLdapConnection, testOssCredentials,
} from './settings-test.service.js';

export interface SystemSettingRouteDeps {
  systemSettingService: SystemSettingService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
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
    return sendOk(reply, await systemSettingService.updateBatch(items));
  });

  app.put('/v1/system-settings/:key', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'settings:write');
    const body = bodyOf<UpdateSettingRequest>(request);
    return sendOk(reply, await systemSettingService.update(pathParam(request, 'key'), body.value));
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
}
