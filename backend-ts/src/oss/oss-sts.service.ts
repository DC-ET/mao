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

export class OssStsService {
  private cachedFingerprint = '';
  private cachedClient: AssumeRoleClient | null = null;

  constructor(
    private readonly getConfig: () => Promise<OssStsConfig | null>,
    private readonly createClient: (sts: OssStsConfig['sts']) => Promise<AssumeRoleClient>,
  ) {}

  async generateStsToken(userId: number, _sessionId?: number | null): Promise<StsTokenVO> {
    const config = await this.getConfig();
    if (config == null) {
      throw new BusinessException(5001, 'OSS 未配置，请在管理后台"系统设置→集成配置"中填写');
    }
    const sts = config.sts;
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
                            "acs:oss:*:*:${config.bucket}/${uploadDir}*"
                          ]
                        }
                      ]
                    }`;
    try {
      const client = await this.resolveClient(config);
      const creds = await client.assumeRole({
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
        bucket: config.bucket,
        region: config.region,
        uploadDir,
      };
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      console.error(`Failed to generate STS token for userId=${userId}`, e);
      throw new BusinessException(5001, `生成 OSS 临时凭证失败: ${(e as Error).message}`);
    }
  }

  private async resolveClient(config: OssStsConfig): Promise<AssumeRoleClient> {
    const fingerprint = JSON.stringify(config.sts);
    if (this.cachedClient == null || this.cachedFingerprint !== fingerprint) {
      this.cachedClient = await this.createClient(config.sts);
      this.cachedFingerprint = fingerprint;
    }
    return this.cachedClient;
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
    default?: StsCtor | {
      default?: StsCtor;
      AssumeRoleRequest?: AssumeRoleRequestCtor;
    };
    Client?: StsCtor;
    AssumeRoleRequest?: AssumeRoleRequestCtor;
  };
  const defaultExport = loaded.default;
  const Sts20150401 = (
    typeof defaultExport === 'function'
      ? defaultExport
      : defaultExport?.default ?? loaded.Client
  );
  const AssumeRoleRequest = loaded.AssumeRoleRequest
    ?? (typeof defaultExport === 'object' ? defaultExport.AssumeRoleRequest : undefined);
  if (typeof Sts20150401 !== 'function') {
    throw new Error('Aliyun STS SDK 未导出 Client');
  }
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
