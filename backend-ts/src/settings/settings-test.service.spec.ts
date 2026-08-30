import { describe, expect, it, vi } from 'vitest';
import {
  FEISHU_APP_TOKEN_URL,
  mergeWithDefaults,
  testFeishuCredentials,
  testLdapConnection,
  testOssCredentials,
} from './settings-test.service.js';
import { BusinessException } from '../common/business-exception.js';
import type { LdapSettings, OssSettings } from './types.js';

const ldapCfg: LdapSettings = {
  enabled: true,
  url: 'ldap://example.test:389',
  baseDn: 'dc=example,dc=test',
  userDn: 'cn=admin,dc=example,dc=test',
  password: 'secret',
  userSearchBase: 'ou=users',
};

describe('testLdapConnection', () => {
  const bind = vi.fn();
  const search = vi.fn();
  const unbind = vi.fn();
  const factory = () => ({ bind, search, unbind });

  it('bindsAndSearchesWithMergedConfig', async () => {
    bind.mockResolvedValue(undefined);
    search.mockResolvedValue({ searchEntries: [] });
    unbind.mockResolvedValue(undefined);
    await testLdapConnection(ldapCfg, factory);
    expect(bind).toHaveBeenCalledWith(ldapCfg.userDn, ldapCfg.password);
    expect(search).toHaveBeenCalledWith('ou=users,dc=example,dc=test', expect.objectContaining({ scope: 'sub' }));
  });

  it('rejectsMissingFields', async () => {
    await expect(testLdapConnection({ ...ldapCfg, url: '' }, factory)).rejects.toBeInstanceOf(BusinessException);
    await expect(testLdapConnection({ ...ldapCfg, password: '' }, factory)).rejects.toThrow(/绑定账号和密码/);
  });

  it('wrapsBindFailure', async () => {
    bind.mockRejectedValue(new Error('invalid credentials'));
    await expect(testLdapConnection(ldapCfg, factory)).rejects.toThrow(/invalid credentials/);
  });
});

describe('testFeishuCredentials', () => {
  it('succeedsWhenAppTokenReturned', async () => {
    const http = { postJson: vi.fn(async () => ({ ok: true, json: { code: 0, app_access_token: 'at' } })) };
    await testFeishuCredentials('app', 'secret', http);
    expect(http.postJson).toHaveBeenCalledWith(FEISHU_APP_TOKEN_URL, { app_id: 'app', app_secret: 'secret' });
  });

  it('failsOnFeishuErrorCode', async () => {
    const http = { postJson: vi.fn(async () => ({ ok: true, json: { code: 10003, msg: 'invalid app_secret' } })) };
    await expect(testFeishuCredentials('app', 'bad', http)).rejects.toThrow(/invalid app_secret/);
  });

  it('failsOnEmptyCredentials', async () => {
    await expect(testFeishuCredentials('', 'secret', { postJson: vi.fn() })).rejects.toThrow(/不能为空/);
  });
});

describe('testOssCredentials', () => {
  const ossCfg: OssSettings = {
    region: 'cn-hangzhou',
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
    bucket: 'bucket',
    sts: {
      regionId: 'cn-hangzhou',
      endpoint: 'sts.cn-hangzhou.aliyuncs.com',
      accessKeyId: 'sak',
      accessKeySecret: 'ssk',
      roleArn: 'acs:ram::1:role/x',
      roleSessionName: 'mao-test',
      expire: 3600,
      maxSizeMb: 50,
    },
  };

  it('callsAssumeRole', async () => {
    const assumeRole = vi.fn(async () => ({}));
    await testOssCredentials(ossCfg, async () => ({ assumeRole }));
    expect(assumeRole).toHaveBeenCalledWith(expect.objectContaining({ roleSessionName: 'mao-test', durationSeconds: 3600 }));
  });

  it('wrapsAssumeRoleFailure', async () => {
    await expect(testOssCredentials(ossCfg, async () => ({
      assumeRole: async () => { throw new Error('denied'); },
    }))).rejects.toThrow(/denied/);
  });
});

describe('mergeWithDefaults', () => {
  it('emptyStringOverridesFallBackToStored', () => {
    const merged = mergeWithDefaults({ url: '', password: 'new' }, ldapCfg);
    expect(merged.url).toBe(ldapCfg.url);
    expect(merged.password).toBe('new');
  });
});
