import { describe, expect, it, vi } from 'vitest';
import {
  FEISHU_APP_TOKEN_URL,
  JEV_DEFAULT_ENDPOINT,
  JEV_DEFAULT_MODEL,
  mergeWithDefaults,
  testFeishuCredentials,
  testJevConnection,
  testLdapConnection,
  testOssCredentials,
  type JevTestHttp,
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

describe('testJevConnection', () => {
  function http(response: { status: number; json: Record<string, unknown> | null; text?: string }): JevTestHttp & { postJson: ReturnType<typeof vi.fn> } {
    return {
      postJson: vi.fn(async () => ({ status: response.status, json: response.json, text: response.text ?? '' })),
    };
  }

  it('postsProbeAndReturnsModel', async () => {
    const client = http({
      status: 200,
      json: { model: 'jev-1.13.0', answers: { probe: { type: 'noul', noul: 0.04 } } },
    });
    const result = await testJevConnection({
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      model: 'typesafe/jev-1.13',
      apiKey: 'sk-test',
    }, client);
    expect(result).toEqual({ model: 'jev-1.13.0', probability: 0.04 });
    expect(client.postJson).toHaveBeenCalledWith(
      'https://openrouter.ai/api/alpha/decisions',
      expect.objectContaining({ model: 'typesafe/jev-1.13', state: { tool: 'read_file', arguments: { path: 'README.md' } } }),
      expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      10_000,
    );
  });

  it('fallsBackToDefaultEndpointAndModel', async () => {
    const client = http({ status: 200, json: { answers: { probe: { type: 'noul', noul: 0.1 } } } });
    const result = await testJevConnection({ endpoint: '  ', model: '', apiKey: 'k' }, client);
    expect(result.model).toBe(JEV_DEFAULT_MODEL);
    expect(client.postJson.mock.calls[0][0]).toBe(JEV_DEFAULT_ENDPOINT);
  });

  it('rejectsEmptyApiKeyWithoutCalling', async () => {
    const client = http({ status: 200, json: {} });
    await expect(testJevConnection({ endpoint: '', model: '', apiKey: '  ' }, client)).rejects.toThrow(/API Key 不能为空/);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it('rejectsNonHttpEndpoint', async () => {
    const client = http({ status: 200, json: {} });
    await expect(testJevConnection({ endpoint: 'ftp://jev.example', model: 'm', apiKey: 'k' }, client)).rejects.toThrow(/http/);
    expect(client.postJson).not.toHaveBeenCalled();
  });

  it('rejectsUnauthorizedKey', async () => {
    const client = http({ status: 401, json: { error: { message: 'invalid api key' } }, text: 'invalid api key' });
    await expect(testJevConnection({ endpoint: 'https://jev.example/v1', model: 'm', apiKey: 'bad' }, client))
      .rejects.toThrow(/API Key 无效或无权限（HTTP 401）/);
  });

  it('includesProviderMessageOnHttpError', async () => {
    const client = http({ status: 400, json: { error: { message: 'model not found' } } });
    await expect(testJevConnection({ endpoint: 'https://jev.example/v1', model: 'nope', apiKey: 'k' }, client))
      .rejects.toThrow(/HTTP 400：model not found/);
  });

  it('rejectsUnparseableSuccessBody', async () => {
    const client = http({ status: 200, json: { ok: true }, text: '{"ok":true}' });
    await expect(testJevConnection({ endpoint: 'https://jev.example/v1', model: 'm', apiKey: 'k' }, client))
      .rejects.toThrow(/不符合决策协议/);
  });

  it('mapsAbortToTimeout', async () => {
    const client: JevTestHttp = {
      postJson: vi.fn(async () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }),
    };
    await expect(testJevConnection({ endpoint: 'https://jev.example/v1', model: 'm', apiKey: 'k' }, client))
      .rejects.toThrow(/超时/);
  });

  it('wrapsNetworkFailure', async () => {
    const client: JevTestHttp = { postJson: vi.fn(async () => { throw new Error('getaddrinfo ENOTFOUND'); }) };
    await expect(testJevConnection({ endpoint: 'https://jev.example/v1', model: 'm', apiKey: 'k' }, client))
      .rejects.toThrow(/ENOTFOUND/);
  });
});

describe('mergeWithDefaults', () => {
  it('emptyStringOverridesFallBackToStored', () => {
    const merged = mergeWithDefaults({ url: '', password: 'new' }, ldapCfg);
    expect(merged.url).toBe(ldapCfg.url);
    expect(merged.password).toBe('new');
  });
});
