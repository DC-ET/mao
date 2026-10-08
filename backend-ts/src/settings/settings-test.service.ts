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
    // 试签不携带 policy：空对象 '{}' 不合 RAM Policy 语法会触发
    // InvalidParameter.PolicyGrammar；不传即沿用角色自身权限，仅校验凭证有效性。
    await client.assumeRole({
      roleArn: cfg.sts.roleArn,
      roleSessionName: 'mao-test',
      durationSeconds: Math.min(Math.max(cfg.sts.expire, 900), 3600),
    });
  } catch (e) {
    fail(`OSS STS 试签失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface OssTestClient {
  assumeRole(input: { roleArn: string; roleSessionName: string; durationSeconds: number; policy?: string }): Promise<unknown>;
}

export function defaultLdapClientFactory(): LdapClientFactory {
  return (url: string) => new Client({ url }) as unknown as LdapTestClient;
}

/** 与 Jev 前置决策默认值一致：端点或模型名为空时回落。 */
export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_MODEL = 'jev-latest';
const JEV_PROBE_TIMEOUT_MS = 10_000;

export interface JevTestConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface JevTestHttpResponse {
  status: number;
  json: Record<string, unknown> | null;
  text: string;
}

export interface JevTestHttp {
  postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<JevTestHttpResponse>;
}

export interface JevTestResult {
  model: string;
  probability: number;
}

/**
 * 验证 Jev 端点与 API Key：发一次只读探测决策，要求返回可解析的 noul 概率。
 * 探测载荷是固定的 read_file，不会触发真实工具。
 */
export async function testJevConnection(cfg: JevTestConfig, http: JevTestHttp): Promise<JevTestResult> {
  const endpoint = (cfg.endpoint ?? '').trim() || JEV_DEFAULT_ENDPOINT;
  const model = (cfg.model ?? '').trim() || JEV_DEFAULT_MODEL;
  const apiKey = (cfg.apiKey ?? '').trim();
  if (!hasText(apiKey)) {
    fail('Jev API Key 不能为空');
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    fail('Jev 端点需以 http:// 或 https:// 开头');
  }

  const body = {
    model,
    state: { tool: 'read_file', arguments: { path: 'README.md' } },
    questions: {
      probe: {
        type: 'noul',
        instructions: 'Is this tool call read-only?',
        criteria: {
          true: 'Read-only inspection',
          false: 'Any write, delete, or external side effect',
        },
      },
    },
  };

  let res: JevTestHttpResponse;
  try {
    res = await http.postJson(endpoint, body, {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }, JEV_PROBE_TIMEOUT_MS);
  } catch (e) {
    if (isAbortError(e)) {
      fail('Jev 接口超时，请检查端点是否可访问');
    }
    fail(`Jev 接口请求失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (res.status === 401 || res.status === 403) {
    fail(`Jev API Key 无效或无权限（HTTP ${res.status}）`);
  }
  if (res.status < 200 || res.status >= 300) {
    fail(`Jev 接口返回 HTTP ${res.status}${formatSnippet(res)}`);
  }
  const probability = readProbeProbability(res.json);
  if (probability == null) {
    fail(`Jev 接口已连通，但响应不符合决策协议${formatSnippet(res)}`);
  }
  const returnedModel = res.json && typeof res.json.model === 'string' && hasText(res.json.model)
    ? res.json.model.trim()
    : model;
  return { model: returnedModel, probability };
}

export function defaultJevHttp(): JevTestHttp {
  return {
    async postJson(url, body, headers, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await response.text();
        return { status: response.status, json: parseJsonObject(text), text };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 非 JSON */
  }
  return null;
}

function readProbeProbability(json: Record<string, unknown> | null): number | null {
  if (!json) return null;
  const answers = json.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const probe = (answers as Record<string, unknown>).probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return null;
  const answer = probe as Record<string, unknown>;
  if (answer.type !== 'noul' || typeof answer.noul !== 'number') return null;
  if (answer.noul < 0 || answer.noul > 1) return null;
  return answer.noul;
}

function formatSnippet(res: JevTestHttpResponse): string {
  const raw = extractProviderMessage(res) || res.text.trim();
  if (!raw) return '';
  return `：${raw.replace(/\s+/g, ' ').slice(0, 180)}`;
}

function extractProviderMessage(res: JevTestHttpResponse): string {
  const json = res.json;
  if (!json) return '';
  const err = json.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && !Array.isArray(err)) {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  if (typeof json.message === 'string') return json.message;
  return '';
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
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
