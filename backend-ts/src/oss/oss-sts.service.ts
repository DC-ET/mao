import { BusinessException } from '../common/business-exception.js';

/** AssumeRole 最多尝试次数（1 次原始 + 2 次重试）。 */
const STS_MAX_ATTEMPTS = 3;
/** 重试基础退避（毫秒）：第 n 次重试等待 base * 2^(n-1)，即 300ms、600ms。 */
const STS_RETRY_BASE_DELAY_MS = 300;
/** Aliyun SDK 底层 httpx 默认 connect/read timeout 仅 3s，首次连接（DNS+TLS+SDK 初始化）极易误判为 ConnectTimeout。 */
const STS_CONNECT_TIMEOUT_MS = 5_000;
const STS_READ_TIMEOUT_MS = 10_000;

/**
 * 判断 STS 失败是否值得重试。只覆盖瞬断（连接/读超时、连接被重置、限流），
 * 配置类与鉴权类错误（InvalidParameter、AccessDenied、未配置等）必须立即返回给用户。
 */
function isTransientStsFailure(failure: unknown): boolean {
  let cause: unknown = failure;
  while (cause) {
    if (cause instanceof BusinessException) return false;
    if (cause instanceof Error) {
      const msg = cause.message ?? '';
      if (
        // Aliyun SDK 传输层把各类超时统一抛成 RequestTimeoutError，消息前缀为 ConnectTimeout:/ReadTimeout:
        cause.name === 'RequestTimeoutError'
        || cause.name === 'RetryError'
        || msg.includes('ConnectTimeout')
        || msg.includes('ReadTimeout')
        || msg.includes('socket hang up')
        || msg.includes('ECONNRESET')
        || msg.includes('ECONNREFUSED')
        || msg.includes('ETIMEDOUT')
        || msg.includes('EPIPE')
        // 限流稍等即可再试
        || msg.includes('Throttling')
      ) {
        return true;
      }
      cause = cause.cause;
      continue;
    }
    break;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

export interface AssumeRoleInput {
  roleArn: string;
  roleSessionName: string;
  durationSeconds: number;
  policy: string;
}

export interface AssumeRoleClient {
  assumeRole(input: AssumeRoleInput): Promise<{
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
      const creds = await this.assumeRoleWithRetry(client, {
        roleArn: sts.roleArn,
        roleSessionName: `User_${userId}`,
        durationSeconds: sts.expire,
        policy,
      }, userId);
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

  private async assumeRoleWithRetry(
    client: AssumeRoleClient,
    input: AssumeRoleInput,
    userId: number,
  ) {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= STS_MAX_ATTEMPTS; attempt++) {
      try {
        return await client.assumeRole(input);
      } catch (e) {
        lastFailure = e;
        if (attempt === STS_MAX_ATTEMPTS || !isTransientStsFailure(e)) throw e;
        console.warn(`STS AssumeRole 第 ${attempt} 次尝试失败，重试中, userId=${userId}: ${(e as Error).message}`);
        await sleep(STS_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
    throw lastFailure;
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
    // 覆盖 SDK 默认的 3s connect/read timeout：首次连接（DNS + TLS + SDK 初始化）常常超过 3s 被误判为 ConnectTimeout
    connectTimeout: STS_CONNECT_TIMEOUT_MS,
    readTimeout: STS_READ_TIMEOUT_MS,
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
