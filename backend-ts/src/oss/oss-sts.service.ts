import type { AppConfig } from '../config/app-config.js';
import { BusinessException } from '../common/business-exception.js';

export interface StsTokenVO {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  bucket: string;
  region: string;
  uploadDir: string;
}

export interface OssStsConfig {
  region: string;
  bucket: string;
  sts: {
    regionId: string;
    endpoint: string;
    accessKeyId: string;
    accessKeySecret: string;
    roleArn: string;
    roleSessionName: string;
    expire: number;
  };
}

export interface AssumeRoleClient {
  assumeRole(input: {
    roleArn: string;
    roleSessionName: string;
    durationSeconds: number;
    policy: string;
  }): Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    expiration: string;
  }>;
}

export function ossConfigFromApp(cfg: AppConfig): OssStsConfig {
  return {
    region: cfg.oss.region,
    bucket: cfg.oss.bucket,
    sts: {
      regionId: cfg.oss.sts.regionId,
      endpoint: cfg.oss.sts.endpoint,
      accessKeyId: cfg.oss.sts.accessKeyId,
      accessKeySecret: cfg.oss.sts.accessKeySecret,
      roleArn: cfg.oss.sts.roleArn,
      roleSessionName: cfg.oss.sts.roleSessionName,
      expire: cfg.oss.sts.expire,
    },
  };
}

export class OssStsService {
  constructor(
    private readonly oss: OssStsConfig,
    private readonly client: AssumeRoleClient,
  ) {}

  async generateStsToken(userId: number, _sessionId?: number | null): Promise<StsTokenVO> {
    const sts = this.oss.sts;
    const uploadDir = 'uploads/';
    const policy = `{
                      "Version": "1",
                      "Statement": [
                        {
                          "Effect": "Allow",
                          "Action": [
                            "oss:PutObject",
                            "oss:PutObjectAcl"
                          ],
                          "Resource": [
                            "acs:oss:*:*:${this.oss.bucket}/${uploadDir}*"
                          ]
                        }
                      ]
                    }`;
    try {
      const creds = await this.client.assumeRole({
        roleArn: sts.roleArn,
        roleSessionName: `User_${userId}`,
        durationSeconds: sts.expire,
        policy,
      });
      return {
        accessKeyId: creds.accessKeyId,
        accessKeySecret: creds.accessKeySecret,
        securityToken: creds.securityToken,
        expiration: creds.expiration,
        bucket: this.oss.bucket,
        region: this.oss.region,
        uploadDir,
      };
    } catch (e) {
      console.error(`Failed to generate STS token for userId=${userId}`, e);
      throw new BusinessException(5001, `生成 OSS 临时凭证失败: ${(e as Error).message}`);
    }
  }
}

export async function createAliyunAssumeRoleClient(sts: OssStsConfig['sts']): Promise<AssumeRoleClient> {
  type StsResponse = {
    body?: { credentials?: Record<string, string> };
    credentials?: Record<string, string>;
  };
  type StsClient = {
    assumeRole(req: unknown): Promise<StsResponse>;
  };
  type StsCtor = new (config: Record<string, unknown>) => StsClient;
  type AssumeRoleRequestCtor = new (map: Record<string, unknown>) => unknown;
  const loaded = await import('@alicloud/sts20150401') as unknown as {
    default?: StsCtor & { AssumeRoleRequest?: AssumeRoleRequestCtor };
    AssumeRoleRequest?: AssumeRoleRequestCtor;
  };
  const Sts20150401 = (loaded.default ?? loaded) as StsCtor;
  const AssumeRoleRequest = loaded.AssumeRoleRequest ?? loaded.default?.AssumeRoleRequest;
  if (typeof AssumeRoleRequest !== 'function') {
    throw new Error('Aliyun STS SDK 未导出 AssumeRoleRequest');
  }
  const client = new Sts20150401({
    accessKeyId: sts.accessKeyId,
    accessKeySecret: sts.accessKeySecret,
    endpoint: sts.endpoint.replace(/^https?:\/\//, ''),
  });
  return {
    async assumeRole(input) {
      const resp = await client.assumeRole(new AssumeRoleRequest({
        roleArn: input.roleArn,
        roleSessionName: input.roleSessionName,
        durationSeconds: input.durationSeconds,
        policy: input.policy,
      }));
      const c = resp.body?.credentials ?? resp.credentials;
      if (c == null) {
        throw new Error('STS AssumeRole 未返回凭证');
      }
      return {
        accessKeyId: c.accessKeyId ?? c.AccessKeyId,
        accessKeySecret: c.accessKeySecret ?? c.AccessKeySecret,
        securityToken: c.securityToken ?? c.SecurityToken,
        expiration: c.expiration ?? c.Expiration,
      };
    },
  };
}
