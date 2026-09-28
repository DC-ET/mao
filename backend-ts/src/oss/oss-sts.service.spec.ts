import { describe, expect, it, vi } from 'vitest';
import { OssStsService } from './oss-sts.service.js';
import { BusinessException } from '../common/business-exception.js';

const oss = {
  region: 'cn-hangzhou',
  bucket: 'mao-bucket',
  sts: {
    regionId: 'cn-hangzhou',
    endpoint: 'sts.cn-hangzhou.aliyuncs.com',
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
    roleArn: 'acs:ram::1:role/oss',
    roleSessionName: 'mao',
    expire: 3600,
  },
};

describe('OssStsService', () => {
  it('generateStsTokenReturnsCredentialsAndUploadDir', async () => {
    const client = {
      assumeRole: vi.fn(async () => ({
        accessKeyId: 'tmp-ak',
        accessKeySecret: 'tmp-sk',
        securityToken: 'token',
        expiration: '2026-08-13T12:00:00Z',
      })),
    };
    const service = new OssStsService(async () => oss, async () => client);
    const vo = await service.generateStsToken(7, 11);
    expect(vo.accessKeyId).toBe('tmp-ak');
    expect(vo.bucket).toBe('mao-bucket');
    expect(vo.region).toBe('cn-hangzhou');
    expect(vo.uploadDir).toBe('uploads/');
    expect(client.assumeRole).toHaveBeenCalledWith(expect.objectContaining({
      roleArn: oss.sts.roleArn,
      roleSessionName: 'User_7',
      durationSeconds: 3600,
    }));
  });

  it('wrapsAssumeRoleFailureAsBusinessException', async () => {
    const service = new OssStsService(async () => oss, async () => ({
      assumeRole: vi.fn(async () => { throw new Error('denied'); }),
    }));
    await expect(service.generateStsToken(1)).rejects.toBeInstanceOf(BusinessException);
  });

  it('retriesOnceOnTransientConnectTimeoutAndReturnsCredentials', async () => {
    const assumeRole = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('ConnectTimeout: Connect https://sts.cn-hangzhou.aliyuncs.com/ failed.'), { name: 'RequestTimeoutError' }))
      .mockResolvedValue({
        accessKeyId: 'tmp-ak', accessKeySecret: 'tmp-sk', securityToken: 'token', expiration: 'exp',
      });
    const service = new OssStsService(async () => oss, async () => ({ assumeRole }));
    const vo = await service.generateStsToken(1);
    expect(vo.accessKeyId).toBe('tmp-ak');
    expect(assumeRole).toHaveBeenCalledTimes(2);
  });

  it('givesUpAfterMaxAttemptsAndReportsLastFailure', async () => {
    const assumeRole = vi.fn()
      .mockRejectedValue(Object.assign(new Error('ConnectTimeout: Connect https://sts.cn-hangzhou.aliyuncs.com/ failed.'), { name: 'RequestTimeoutError' }));
    const service = new OssStsService(async () => oss, async () => ({ assumeRole }));
    await expect(service.generateStsToken(1)).rejects.toThrow(/生成 OSS 临时凭证失败/);
    expect(assumeRole).toHaveBeenCalledTimes(3);
  });

  it('doesNotRetryConfigurationErrors', async () => {
    const assumeRole = vi.fn().mockRejectedValue(
      new Error('code: 400, InvalidParameter.PolicyGrammar request id: r1'),
    );
    const service = new OssStsService(async () => oss, async () => ({ assumeRole }));
    await expect(service.generateStsToken(1)).rejects.toThrow(/InvalidParameter.PolicyGrammar/);
    expect(assumeRole).toHaveBeenCalledTimes(1);
  });

  it('doesNotRetryBusinessExceptionThrownByClientFactory', async () => {
    const assumeRole = vi.fn();
    const service = new OssStsService(async () => oss, async () => {
      throw new BusinessException(5001, 'OSS 未配置，请在管理后台"系统设置→集成配置"中填写');
    });
    await expect(service.generateStsToken(1)).rejects.toThrow(/OSS 未配置/);
    expect(assumeRole).not.toHaveBeenCalled();
  });

  it('rejectsWhenOssNotConfigured', async () => {
    const service = new OssStsService(async () => null, async () => {
      throw new Error('should not be called');
    });
    await expect(service.generateStsToken(1)).rejects.toThrow(/OSS 未配置/);
  });

  it('reusesClientWhenStsConfigUnchanged', async () => {
    const assumeRole = vi.fn(async () => ({
      accessKeyId: 'a', accessKeySecret: 'b', securityToken: 'c', expiration: 'd',
    }));
    let createCalls = 0;
    const service = new OssStsService(async () => oss, async () => {
      createCalls += 1;
      return { assumeRole };
    });
    await service.generateStsToken(1);
    await service.generateStsToken(2);
    expect(createCalls).toBe(1);
    expect(assumeRole).toHaveBeenCalledTimes(2);
  });
});

describe('createAliyunAssumeRoleClient', () => {
  it('aliyunAssumeRoleRequestHasValidate', async () => {
    const loaded = await import('@alicloud/sts20150401') as { AssumeRoleRequest: new (map: Record<string, unknown>) => { validate?: () => void } };
    const req = new loaded.AssumeRoleRequest({
      roleArn: oss.sts.roleArn,
      roleSessionName: 'User_1',
      durationSeconds: 3600,
      policy: '{}',
    });
    expect(typeof req.validate).toBe('function');
  });
});
