import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SystemSettingService } from './settings.service.js';
import { encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type { AgentLookup, ModelLookup, SystemSetting, SystemSettingRepository } from './types.js';

function setting(key: string, category: string, editable: number): SystemSetting {
  return { id: 1, settingKey: key, category, value: '20', editable };
}

describe('SystemSettingService', () => {
  beforeEach(() => {
    vi.mocked(mapper.list).mockReset();
    vi.mocked(mapper.findByKey).mockReset();
    vi.mocked(mapper.updateById).mockReset();
    vi.mocked(agentLookup.findById).mockReset();
    vi.mocked(modelLookup.findById).mockReset();
  });

  const mapper: SystemSettingRepository = {
    list: vi.fn(),
    findByKey: vi.fn(),
    updateById: vi.fn(),
  };
  const agentLookup: AgentLookup = { findById: vi.fn() };
  const modelLookup: ModelLookup = { findById: vi.fn() };
  const runtime = {
    workspaceRoot: '/workspace',
    skillsDir: '/skills',
  };

  function service(): SystemSettingService {
    return new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime });
  }

  it('updateRejectsReadonlySetting', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting('workspace.root', '运行环境', 0));
    await expect(service().update('workspace.root', '/tmp/workspace')).rejects.toThrow(BusinessException);
    await expect(service().update('workspace.root', '/tmp/workspace')).rejects.toThrow(/仅展示/);
  });

  it('updateValidatesPositiveIntegerSettings', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting('audit.retentionDays', '审计', 1));
    await expect(service().update('audit.retentionDays', '0')).rejects.toThrow(/正整数/);
  });

  it('updatePersistsEditableSetting', async () => {
    const row = setting('ui.defaultPageSize', '界面', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    const updated = await service().update('ui.defaultPageSize', '50');
    expect(updated.value).toBe('50');
    expect(mapper.updateById).toHaveBeenCalledWith(row);
  });

  it('updateAllowsEmptyWeixinAgentId', async () => {
    const row = setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, '微信', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    const updated = await service().update(SystemSettingService.WEIXIN_AGENT_ID_KEY, '');
    expect(updated.value).toBe('');
    expect(mapper.updateById).toHaveBeenCalledWith(row);
  });

  it('updateValidatesWeixinAgentExists', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, '微信', 1));
    vi.mocked(agentLookup.findById).mockResolvedValue(null);
    await expect(service().update(SystemSettingService.WEIXIN_AGENT_ID_KEY, '9')).rejects.toThrow(/Agent 不存在/);
  });

  it('updateAcceptsValidWeixinAgentId', async () => {
    const row = setting(SystemSettingService.WEIXIN_AGENT_ID_KEY, '微信', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    vi.mocked(agentLookup.findById).mockResolvedValue({ id: 9 });
    const updated = await service().update(SystemSettingService.WEIXIN_AGENT_ID_KEY, '9');
    expect(updated.value).toBe('9');
  });

  it('updateAllowsEmptyWeixinModelId', async () => {
    const row = setting(SystemSettingService.WEIXIN_MODEL_ID_KEY, '微信', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    const updated = await service().update(SystemSettingService.WEIXIN_MODEL_ID_KEY, '');
    expect(updated.value).toBe('');
  });

  it('updateValidatesWeixinModelExists', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting(SystemSettingService.WEIXIN_MODEL_ID_KEY, '微信', 1));
    vi.mocked(modelLookup.findById).mockResolvedValue(null);
    await expect(service().update(SystemSettingService.WEIXIN_MODEL_ID_KEY, '8')).rejects.toThrow(/模型不存在/);
  });

  it('updateAcceptsValidWeixinModelId', async () => {
    const row = setting(SystemSettingService.WEIXIN_MODEL_ID_KEY, '微信', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    vi.mocked(modelLookup.findById).mockResolvedValue({ id: 8 });
    const updated = await service().update(SystemSettingService.WEIXIN_MODEL_ID_KEY, '8');
    expect(updated.value).toBe('8');
  });

  it('updateAllowsEmptyTitleModelId', async () => {
    const row = setting(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '会话', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    const updated = await service().update(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '');
    expect(updated.value).toBe('');
  });

  it('updateValidatesTitleModelExists', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '会话', 1));
    vi.mocked(modelLookup.findById).mockResolvedValue(null);
    await expect(service().update(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '8')).rejects.toThrow(/模型不存在/);
  });

  it('updateAcceptsValidTitleModelId', async () => {
    const row = setting(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '会话', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    vi.mocked(modelLookup.findById).mockResolvedValue({ id: 8 });
    const updated = await service().update(SystemSettingService.SESSION_TITLE_MODEL_ID_KEY, '8');
    expect(updated.value).toBe('8');
  });

  it('updateAllowsEmptyGitCommitMessageModelId', async () => {
    const row = setting(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '代码', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    const updated = await service().update(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '');
    expect(updated.value).toBe('');
  });

  it('updateValidatesGitCommitMessageModelExists', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '代码', 1));
    vi.mocked(modelLookup.findById).mockResolvedValue(null);
    await expect(service().update(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '8')).rejects.toThrow(/模型不存在/);
  });

  it('updateAcceptsValidGitCommitMessageModelId', async () => {
    const row = setting(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '代码', 1);
    vi.mocked(mapper.findByKey).mockResolvedValue(row);
    vi.mocked(modelLookup.findById).mockResolvedValue({ id: 8 });
    const updated = await service().update(SystemSettingService.GIT_COMMIT_MESSAGE_MODEL_ID_KEY, '8');
    expect(updated.value).toBe('8');
  });

  it('listReturnsLdapSwitchAsStoredDbValue', async () => {
    vi.mocked(mapper.list).mockResolvedValue([setting('auth.ldap.enabled', '集成配置', 1)]);
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime });
    expect((await svc.list(null))[0].value).toBe('20');
  });

  it('listMasksSecretValues', async () => {
    const secretRow = setting('auth.feishu.appSecret', '集成配置', 1);
    secretRow.isSecret = 1;
    secretRow.value = 'enc:v1:ciphertext';
    vi.mocked(mapper.list).mockResolvedValue([secretRow]);
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, 'k');
    expect((await svc.list(null))[0].value).toBe('******');
  });

  it('updateSecretEncryptsAndDecryptsRoundTrip', async () => {
    const secretRow = setting('auth.feishu.appSecret', '集成配置', 1);
    secretRow.isSecret = 1;
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (key === 'auth.feishu.appSecret') return secretRow;
      return null;
    });
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, 'test-secret-key');
    const updated = await svc.update('auth.feishu.appSecret', 'my-app-secret');
    expect(updated.value).toBe('******');
    expect(secretRow.value).not.toBe('my-app-secret');
    expect(String(secretRow.value)).toContain(':');
    const cfg = await svc.getFeishuOAuthConfig();
    expect(cfg.appSecret).toBe('my-app-secret');
    expect(cfg.redirectUri).toBe('http://localhost:9080/api/v1/auth/feishu/callback');
  });

  it('updateSecretRejectsMaskSubmission', async () => {
    const secretRow = setting('auth.ldap.password', '集成配置', 1);
    secretRow.isSecret = 1;
    secretRow.value = 'enc:v1:ciphertext';
    vi.mocked(mapper.findByKey).mockResolvedValue(secretRow);
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, 'k');
    await expect(svc.update('auth.ldap.password', '******')).rejects.toThrow(/掩码/);
  });

  it('updateSecretNullMeansNoChange', async () => {
    const secretRow = setting('auth.ldap.password', '集成配置', 1);
    secretRow.isSecret = 1;
    secretRow.value = 'enc:v1:ciphertext';
    vi.mocked(mapper.findByKey).mockResolvedValue(secretRow);
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, 'k');
    const result = await svc.update('auth.ldap.password', null);
    expect(result.value).toBe('******');
    expect(mapper.updateById).not.toHaveBeenCalled();
  });

  it('updateSecretRejectsWhenSecretKeyMissing', async () => {
    const secretRow = setting('tools.tavilyApiKey', '集成配置', 1);
    secretRow.isSecret = 1;
    vi.mocked(mapper.findByKey).mockResolvedValue(secretRow);
    const svc = new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, '');
    await expect(svc.update('tools.tavilyApiKey', 'tvly-xxx')).rejects.toThrow(/SETTINGS_SECRET/);
  });

  it('updateValidatesStorageModeEnum', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting('upload.storageMode', '集成配置', 1));
    await expect(service().update('upload.storageMode', 's3')).rejects.toThrow(/local 或 oss/);
  });

  it('updateValidatesWebSearchProviderEnum', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting('tools.webSearchProvider', '集成配置', 1));
    await expect(service().update('tools.webSearchProvider', 'bing')).rejects.toThrow(/tavily 或 tinyfish/);
  });

  it('getWebSearchConfigDefaultsToTavily', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(null);
    const cfg = await service().getWebSearchConfig();
    expect(cfg.provider).toBe('tavily');
    expect(cfg.tavily.apiKey).toBe('');
    expect(cfg.tavily.maxResults).toBe(5);
    expect(cfg.tinyfish.apiKey).toBe('');
    expect(cfg.tinyfish.baseUrl).toBe('https://api.search.tinyfish.ai');
  });

  it('getWebSearchConfigReadsTinyfishProvider', async () => {
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (key === 'tools.webSearchProvider') return { id: 1, settingKey: key, value: 'tinyfish', category: '集成配置', editable: 1 } as SystemSetting;
      return null;
    });
    const cfg = await service().getWebSearchConfig();
    expect(cfg.provider).toBe('tinyfish');
  });

  it('updateValidatesLdapUrlScheme', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(setting('auth.ldap.url', '集成配置', 1));
    await expect(service().update('auth.ldap.url', 'example.test')).rejects.toThrow(/ldap:\/\/ 或 ldaps:\/\//);
  });

  it('getUploadConfigAppliesDefaults', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(null);
    const cfg = await service().getUploadConfig();
    expect(cfg).toEqual({ storageMode: 'local', baseUrl: '', maxSizeMb: 50 });
  });

  it('getAgentRuntimeConfigAppliesDefaults', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(null);
    const cfg = await service().getAgentRuntimeConfig();
    expect(cfg).toEqual({ threadPoolSize: 20, threadPoolMax: 100, threadPoolQueue: 200, wsIdleTimeoutMs: 90000 });
  });

  it('getAgentRuntimeConfigReadsStoredValues', async () => {
    const rows: Record<string, string> = {
      'agent.threadPoolSize': '8',
      'agent.threadPoolMax': '16',
      'agent.threadPoolQueue': '32',
      'ws.idleTimeoutMs': '60000',
    };
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (rows[key] != null) return { id: 1, settingKey: key, value: rows[key], category: '运行参数', editable: 1 };
      return null;
    });
    const cfg = await service().getAgentRuntimeConfig();
    expect(cfg).toEqual({ threadPoolSize: 8, threadPoolMax: 16, threadPoolQueue: 32, wsIdleTimeoutMs: 60000 });
  });

  it('getNotificationTuningConfigAppliesDefaultsAndReadsValues', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(null);
    expect(await service().getNotificationTuningConfig()).toEqual({ workerDelayMs: 30000, batchSize: 100, maxAttempts: 4 });

    const rows: Record<string, string> = {
      'notify.workerDelayMs': '5000',
      'notify.batchSize': '20',
      'notify.maxAttempts': '6',
    };
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (rows[key] != null) return { id: 1, settingKey: key, value: rows[key], category: '运行参数', editable: 1 };
      return null;
    });
    expect(await service().getNotificationTuningConfig()).toEqual({ workerDelayMs: 5000, batchSize: 20, maxAttempts: 6 });
  });

  it('updateRejectsInvalidRuntimeTuningValues', async () => {
    for (const key of ['agent.threadPoolSize', 'ws.idleTimeoutMs', 'notify.workerDelayMs', 'notify.batchSize', 'notify.maxAttempts']) {
      vi.mocked(mapper.findByKey).mockResolvedValue(setting(key, '运行参数', 1));
      await expect(service().update(key, '0')).rejects.toThrow(/正整数/);
      await expect(service().update(key, 'abc')).rejects.toThrow(/正整数/);
    }
  });

  it('getOssConfigReturnsNullWhenUnconfigured', async () => {
    vi.mocked(mapper.findByKey).mockResolvedValue(null);
    expect(await service().getOssConfig()).toBeNull();
  });

  it('getOssConfigReturnsFullConfigWhenSet', async () => {
    const rows: Record<string, string> = {
      'oss.region': 'cn-hangzhou',
      'oss.accessKeyId': 'ak',
      'oss.accessKeySecret': encryptAesGcmNonNull('sk', 'test-secret-key'),
      'oss.bucket': 'bucket',
      'oss.sts.roleArn': 'acs:ram::1:role/x',
    };
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (rows[key] != null) return { id: 1, settingKey: key, value: rows[key], category: '集成配置', editable: 1 };
      return null;
    });
    const cfg = await new SystemSettingService(mapper, agentLookup, modelLookup, { ...runtime }, 'test-secret-key').getOssConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.region).toBe('cn-hangzhou');
    expect(cfg!.sts.roleSessionName).toBe('mao-sts');
    expect(cfg!.sts.expire).toBe(3600);
  });

  it('getLdapConfigReadsEnabledFlag', async () => {
    const rows: Record<string, string> = {
      'auth.ldap.enabled': 'true',
      'auth.ldap.url': 'ldap://example.test:389',
      'auth.ldap.baseDn': 'dc=example,dc=test',
      'auth.ldap.userDn': 'cn=admin,dc=example,dc=test',
    };
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (rows[key] != null) return { id: 1, settingKey: key, value: rows[key], category: '集成配置', editable: 1 };
      return null;
    });
    const cfg = await service().getLdapConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.url).toBe('ldap://example.test:389');
    expect(cfg.userSearchBase).toBe('ou=users');
  });

  it('updateBatchValidatesAllBeforeApplying', async () => {
    const okRow = setting('upload.storageMode', '集成配置', 1);
    vi.mocked(mapper.findByKey).mockImplementation(async (key: string) => {
      if (key === 'upload.storageMode') return okRow;
      return null;
    });
    await expect(service().updateBatch([
      { key: 'upload.storageMode', value: 'oss' },
      { key: 'missing.key', value: 'x' },
    ])).rejects.toThrow(/不存在/);
    expect(mapper.updateById).not.toHaveBeenCalled();
  });
});
