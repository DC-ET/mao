import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SystemSettingService } from './settings.service.js';
import type { AgentLookup, ModelLookup, SystemSetting, SystemSettingRepository } from './types.js';

function setting(key: string, category: string, editable: number): SystemSetting {
  return { id: 1, settingKey: key, category, value: '20', editable };
}

describe('SystemSettingService', () => {
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
    ldapEnabled: false,
    ldapUrl: '',
    feishuEnabled: false,
    feishuAppId: '',
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

  it('listShowsLdapEnabledOnlyWhenSwitchAndUrlArePresent', async () => {
    const ldapSetting = setting('auth.ldap.enabled', '认证', 0);
    vi.mocked(mapper.list).mockResolvedValue([ldapSetting]);

    const disabled = new SystemSettingService(mapper, agentLookup, modelLookup, {
      ...runtime,
      ldapEnabled: true,
      ldapUrl: '',
    });
    expect((await disabled.list(null))[0].value).toBe('false');

    const enabled = new SystemSettingService(mapper, agentLookup, modelLookup, {
      ...runtime,
      ldapEnabled: true,
      ldapUrl: 'ldap://example.test:389',
    });
    expect((await enabled.list(null))[0].value).toBe('true');
  });

  it('listShowsFeishuEnabledOnlyWhenSwitchAndAppIdArePresent', async () => {
    const feishuSetting = setting('auth.feishu.enabled', '认证', 0);
    vi.mocked(mapper.list).mockResolvedValue([feishuSetting]);

    const disabled = new SystemSettingService(mapper, agentLookup, modelLookup, {
      ...runtime,
      feishuEnabled: true,
      feishuAppId: '',
    });
    expect((await disabled.list(null))[0].value).toBe('false');

    const enabled = new SystemSettingService(mapper, agentLookup, modelLookup, {
      ...runtime,
      feishuEnabled: true,
      feishuAppId: 'cli_xxx',
    });
    expect((await enabled.list(null))[0].value).toBe('true');
  });
});
