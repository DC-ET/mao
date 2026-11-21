import { Client } from 'ldapts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { EmailSmtpSettings, LdapSettings, OssSettings } from './types.js';

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

/**
 * 对象存储连通性测试（多云预签名直传，技术方案 2026-11-21）：
 * 对固定探针 key 真实发起预签名 PUT（写入 1 字节内容）后尽力 DELETE 清理。
 * PUT 成功即证明 AccessKey 有效、bucket 存在且可写——比旧 STS 试签（只验凭证）
 * 验证得更完整；DELETE 失败不影响结论。
 */
export type StorageProbeMethod = 'PUT' | 'DELETE';

export interface StorageProbeHttp {
  request(url: string, init: { method: StorageProbeMethod; headers?: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; body: string }>;
}

export interface ObjectStorageProbeDeps {
  /** 对探针 key 签发预签名 URL；contentType 仅 OBS 参与签名，其余云忽略。 */
  sign: (key: string, expiresSeconds: number, method: StorageProbeMethod, contentType: string) => string;
}

export const STORAGE_PROBE_KEY = 'uploads/.mao-probe';

export function defaultStorageProbeHttp(timeoutMs = 10_000): StorageProbeHttp {
  return {
    async request(url, init) {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
    },
  };
}

export async function testObjectStorageProbe(
  label: string,
  requiredEntries: Array<[string, string]>,
  deps: ObjectStorageProbeDeps,
  http: StorageProbeHttp = defaultStorageProbeHttp(),
): Promise<void> {
  for (const [fieldName, value] of requiredEntries) {
    if (!hasText(value)) {
      fail(`${fieldName} 不能为空`);
    }
  }
  let putRes: { ok: boolean; status: number; body: string };
  try {
    putRes = await http.request(deps.sign(STORAGE_PROBE_KEY, 60, 'PUT', 'text/plain'), {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: 'mao-probe',
    });
  } catch (e) {
    fail(`${label} 连接失败: ${e instanceof Error ? e.message : String(e)}（请检查 endpoint/region 与网络连通性，浏览器直传还需 bucket CORS 放行）`);
  }
  if (!putRes.ok) {
    fail(`${label} 预签名直传被拒绝 (HTTP ${putRes.status})：请确认 AccessKey 对 bucket 有写入权限${putRes.body ? `；响应: ${putRes.body.slice(0, 200)}` : ''}`);
  }
  try {
    await http.request(deps.sign(STORAGE_PROBE_KEY, 60, 'DELETE', ''), { method: 'DELETE' });
  } catch {
    // 探针清理失败不影响连通性结论
  }
}

/** 邮箱格式：与 user.service.ts / settings.service.ts 保存校验口径一致。 */
const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;

/** 邮件发送最小形状（EmailWebhookSender 满足；测试可注入 stub）。 */
export interface EmailTestSender {
  send(to: string, message: { text: string }): Promise<{ success: boolean; error: string | null }>;
}

/**
 * 验证 SMTP 配置（决策 8）：用当前（表单 overrides 与已存合并后的）配置发一封
 * 测试邮件到管理员自己的 user.email。管理员未填邮箱时拒绝并提示先去个人资料填写。
 * cfg.enabled 由路由强制置 true：未启用的实例也要能先测通再开启。
 */
export async function testSmtpConnection(cfg: EmailSmtpSettings, toEmail: string, sender: EmailTestSender): Promise<void> {
  if (!hasText(toEmail)) {
    fail('请先在个人资料中填写邮箱，再测试邮件通知');
  }
  if (!EMAIL_PATTERN.test(toEmail.trim())) {
    fail('个人资料中的邮箱格式不正确，请先修改');
  }
  if (!cfg.enabled || !hasText(cfg.smtpHost)) {
    fail('SMTP 服务器地址不能为空');
  }
  if (!Number.isInteger(cfg.smtpPort) || cfg.smtpPort < 1 || cfg.smtpPort > 65535) {
    fail('SMTP 端口必须是 1-65535 之间的整数');
  }
  if (hasText(cfg.fromAddr) && !EMAIL_PATTERN.test(cfg.fromAddr.trim())) {
    fail('发件人地址邮箱格式不正确');
  }
  if (!hasText(cfg.fromAddr) && !hasText(cfg.smtpUser)) {
    fail('发件人地址不能为空（留空则使用 SMTP 用户名）');
  }
  const result = await sender.send(toEmail.trim(), {
    text: 'Mao Agent 测试通知\n这是一封来自 Mao 管理后台的测试邮件，表示 SMTP 配置可用。',
  });
  if (!result.success) {
    fail(result.error ?? '测试邮件发送失败');
  }
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
