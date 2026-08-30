import { Client } from 'ldapts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { LdapSettings, OssSettings } from './types.js';

export interface LdapTestClient {
  bind(dn: string, password: string): Promise<void>;
  search(base: string, options: Record<string, unknown>): Promise<{ searchEntries: unknown[] }>;
  unbind(): Promise<void>;
}

export type LdapClientFactory = (url: string) => LdapTestClient;

/** 飞书开放平台 OAuth 端点（官方固定地址，不做后台配置）。 */
export const FEISHU_AUTHORIZE_URL = 'https://open.feishu.cn/open-apis/authen/v1/authorize';
export const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token';
export const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
export const FEISHU_APP_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';

export interface FeishuTestHttp {
  postJson(url: string, body: unknown, headers?: Record<string, string>): Promise<{ ok: boolean; json: Record<string, unknown> }>;
}

function fail(message: string): never {
  throw new BusinessException(ErrorCode.PARAM_INVALID, message);
}

/** 验证 LDAP 连通性：管理账号 bind + 在 userSearchBase 下执行一次搜索。 */
export async function testLdapConnection(cfg: LdapSettings, clientFactory: LdapClientFactory): Promise<void> {
  if (!hasText(cfg.url) || !hasText(cfg.baseDn)) {
    fail('LDAP 地址和 Base DN 不能为空');
  }
  if (!hasText(cfg.userDn) || !hasText(cfg.password)) {
    fail('LDAP 绑定账号和密码不能为空');
  }
  const client = clientFactory(cfg.url);
  try {
    await client.bind(cfg.userDn, cfg.password);
    const searchBase = `${cfg.userSearchBase},${cfg.baseDn}`;
    await client.search(searchBase, { scope: 'sub', filter: '(objectClass=*)', sizeLimit: 1, attributes: ['dn'] });
  } catch (e) {
    fail(`LDAP 连接失败: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}

/** 验证飞书应用凭证：用 appId/appSecret 换取 app_access_token。 */
export async function testFeishuCredentials(appId: string, appSecret: string, http: FeishuTestHttp): Promise<void> {
  if (!hasText(appId) || !hasText(appSecret)) {
    fail('飞书 App ID 和 App Secret 不能为空');
  }
  let res: { ok: boolean; json: Record<string, unknown> };
  try {
    res = await http.postJson(FEISHU_APP_TOKEN_URL, { app_id: appId, app_secret: appSecret });
  } catch (e) {
    fail(`飞书接口请求失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    fail('飞书应用凭证接口请求失败');
  }
  if (Number(res.json.code) !== 0) {
    fail(`飞书接口错误: ${String(res.json.msg ?? '')}`);
  }
}

/** 验证 OSS/STS 凭证：真实发起一次 AssumeRole 试签。 */
export async function testOssCredentials(
  cfg: OssSettings,
  createClient: (sts: OssSettings['sts']) => Promise<OssTestClient>,
): Promise<void> {
  if (!hasText(cfg.region) || !hasText(cfg.bucket) || !hasText(cfg.sts.accessKeyId) || !hasText(cfg.sts.accessKeySecret)) {
    fail('OSS Region、Bucket、STS AccessKey 不能为空');
  }
  try {
    const client = await createClient(cfg.sts);
    await client.assumeRole({
      roleArn: cfg.sts.roleArn,
      roleSessionName: 'mao-test',
      durationSeconds: Math.min(Math.max(cfg.sts.expire, 900), 3600),
      policy: '{}',
    });
  } catch (e) {
    fail(`OSS STS 试签失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface OssTestClient {
  assumeRole(input: { roleArn: string; roleSessionName: string; durationSeconds: number; policy: string }): Promise<unknown>;
}

export function defaultLdapClientFactory(): LdapClientFactory {
  return (url: string) => new Client({ url }) as unknown as LdapTestClient;
}

/** 供测试接口复用：入参缺省（null/空串）时回落到已保存配置。 */
export function mergeWithDefaults<T>(overrides: Partial<T>, stored: T): T {
  const out = { ...stored };
  for (const [k, v] of Object.entries(overrides)) {
    if (v != null && !(typeof v === 'string' && !hasText(v))) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
