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
    const service = new OssStsService(oss, client);
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
    const service = new OssStsService(oss, {
      assumeRole: vi.fn(async () => { throw new Error('denied'); }),
    });
    await expect(service.generateStsToken(1)).rejects.toBeInstanceOf(BusinessException);
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
