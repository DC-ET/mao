import {
  areIpsInCidrAllowlist, isCloudMetadataHost, isCloudMetadataIp, isLoopbackIp,
  isPrivateOrReservedHostname, isPrivateOrReservedIp, isValidCidr, resolveHostIps,
} from '../../../common/ssrf.js';
import { RESPONSE_MAX_BYTES, type ResolvedHttpTool, type HttpToolParam } from '../../../http-tool/types.js';

/** 默认请求头（用户头覆盖；Content-Type 仅在有请求体时默认给出）。 */
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; AgentWorkbench/1.0)';
/** 跟随重定向上限（对齐 open_web_page 的重定向处理口径，每跳重新 SSRF 判定）。 */
const MAX_REDIRECTS = 2;
/** body 模板与 URL 查询串共用的占位符：{{参数名}}，单遍替换不递归（参数值里的 {{ 不再展开）。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
/** 非 2xx 响应体入错误信息的片段上限。 */
const ERROR_SNIPPET_CHARS = 500;

export interface HttpApiExecutorDeps {
  /** 系统设置 tools.http.privateAllowlist 的 CIDR 列表提供者（5s TTL 缓存，查询失败按空数组处理）。 */
  allowlistProvider: () => Promise<string[]>;
  /** 注入 fetch 便于测试；缺省用全局 fetch（Node 22 内置）。 */
  fetchImpl?: typeof fetch;
  /** 注入 DNS 解析便于测试；缺省 node:dns。 */
  resolveIps?: (hostname: string) => Promise<string[]>;
  /** 放行名单缓存 TTL（毫秒），默认 5000。 */
  allowlistTtlMs?: number;
}

export interface HttpExecutionSuccess {
  status: number;
  body: string;
  truncated: boolean;
  /** 工具中文展示名（结果摘要层还原「调用 <中文名>」用，非敏感信息）。 */
  displayName: string;
  /** 非文本响应的可读提示（HTTP 调用本身成功，仅 body 不返回）。 */
  notice?: string;
}

export interface HttpExecutionFailure {
  error: string;
  /** 工具中文展示名（失败态一并带回，摘要层失败也显示「调用 <中文名>」）。 */
  displayName?: string;
}

export type HttpExecutionResult = HttpExecutionSuccess | HttpExecutionFailure;

const SSRF_DENY_MESSAGE = '请求被拒绝：目标地址不在允许访问的网段内'
  + '（私网/环回/链路本地/云元数据地址默认拒绝，环回与云元数据永不允许放行；'
  + '如需访问内网服务，请联系管理员在系统设置「自定义 HTTP 工具」中放行对应网段）';

/**
 * 自定义 HTTP 工具执行内核（技术方案 §5.5）：装载定义 → 校验启用与属主（调用方）→
 * SSRF 判定 → 渲染 URL 占位与 body → 解密 headers → fetch → 截断 → 归一化。
 * 纯函数 + 注入 fetch / DNS，便于单测；与正式调用、试运行调试台同一代码路径。
 */
export class HttpApiExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveIps: (hostname: string) => Promise<string[]>;
  private readonly allowlistTtlMs: number;
  private cachedAllowlist: string[] | null = null;
  private allowlistExpiresAt = 0;

  constructor(private readonly deps: HttpApiExecutorDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.resolveIps = deps.resolveIps ?? resolveHostIps;
    this.allowlistTtlMs = deps.allowlistTtlMs ?? 5000;
  }

  async execute(
    tool: ResolvedHttpTool,
    params: HttpToolParam[],
    argumentsJson: string,
  ): Promise<HttpExecutionResult> {
    const parsedArgs = parseArgsObject(argumentsJson);
    if ('error' in parsedArgs) return { error: parsedArgs.error, displayName: tool.displayName };
    const validationError = validateArguments(params, parsedArgs.value);
    if (validationError != null) return { error: validationError, displayName: tool.displayName };

    const method = tool.method.trim().toUpperCase();
    const hasBody = tool.bodyTemplate != null && tool.bodyTemplate !== ''
      && method !== 'GET' && method !== 'HEAD';
    const body = hasBody
      ? renderBodyTemplate(tool.bodyTemplate!, params, parsedArgs.value)
      : undefined;
    const headers = buildHeaders(tool, body != null);
    // URL 查询串 / 路径占位与 body 模板同一套 {{参数名}} 语义（GET 工具唯一入参通道）
    const renderedUrl = renderUrlTemplate(tool.url, params, parsedArgs.value);

    let currentUrl: URL;
    try {
      currentUrl = new URL(renderedUrl);
    } catch {
      return { error: 'URL 格式不正确', displayName: tool.displayName };
    }
    let currentMethod = method;
    let currentBody = body;
    let redirects = 0;

    for (;;) {
      const guard = await this.guardUrl(currentUrl);
      if ('error' in guard) return { error: guard.error, displayName: tool.displayName };
      let res: Response;
      try {
        res = await this.fetchImpl(currentUrl.toString(), {
          method: currentMethod,
          headers,
          body: currentBody,
          redirect: 'manual',
          signal: AbortSignal.timeout(tool.timeoutMs),
        });
      } catch (e) {
        return { error: normalizeNetworkError(e, tool.timeoutMs), displayName: tool.displayName };
      }
      const status = res.status;
      const location = res.headers.get('location');
      if (status >= 300 && status < 400 && location) {
        if (redirects >= MAX_REDIRECTS) {
          return { error: `重定向次数过多（超过 ${MAX_REDIRECTS} 次），已停止跟随`, displayName: tool.displayName };
        }
        redirects++;
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          return { error: '重定向地址无效', displayName: tool.displayName };
        }
        // 301/302/303 对非 GET/HEAD 按标准降级为 GET 且不再带 body
        if ((status === 301 || status === 302 || status === 303)
          && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
          currentMethod = 'GET';
          currentBody = undefined;
          delete headers['Content-Type'];
        }
        currentUrl = next;
        continue;
      }
      return await this.readResult(res, tool);
    }
  }

  /** SSRF 判定：环回 / 云元数据硬拒绝先行，其余私网段全部解析 IP 命中放行名单才放行。 */
  private async guardUrl(url: URL): Promise<{ ok: true } | { error: string }> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { error: '仅支持 http/https 协议' };
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (hostname === '') {
      return { error: 'URL 缺少主机名' };
    }
    if (hostname.includes(':')) {
      // P1 明示不支持 IPv6 端点：CIDR 放行对 IPv6 字面量不可用
      return { error: '暂不支持 IPv6 端点（P1 仅支持 IPv4）' };
    }
    if (isCloudMetadataHost(hostname)) {
      return { error: SSRF_DENY_MESSAGE };
    }
    const ips = await this.resolveIps(hostname);
    for (const ip of ips) {
      if (isLoopbackIp(ip) || isCloudMetadataIp(ip)) {
        return { error: SSRF_DENY_MESSAGE };
      }
    }
    const needsAllowlist = isPrivateOrReservedHostname(hostname) || ips.some(isPrivateOrReservedIp);
    if (!needsAllowlist) {
      return { ok: true };
    }
    const cidrs = await this.getAllowlist();
    // 逐个 IP 判定：任一解析结果不在名单内即拒绝——fetch 连哪个地址由运行时择优，
    // 只放行命中项会让请求落到管理员未批准的网段（DNS 多 A 记录场景）。
    if (areIpsInCidrAllowlist(ips, cidrs)) {
      return { ok: true };
    }
    return { error: SSRF_DENY_MESSAGE };
  }

  /** 放行名单 5s TTL 缓存；查询失败按空数组处理（失败即拒绝，不放开）。 */
  private async getAllowlist(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedAllowlist != null && now < this.allowlistExpiresAt) {
      return this.cachedAllowlist;
    }
    let cidrs: string[];
    try {
      cidrs = await this.deps.allowlistProvider();
    } catch {
      return [];
    }
    const normalized = (Array.isArray(cidrs) ? cidrs : [])
      .map((cidr) => (typeof cidr === 'string' ? cidr.trim() : ''))
      .filter(isValidCidr)
      .map((cidr) => (cidr.includes('/') ? cidr : `${cidr}/32`));
    this.cachedAllowlist = normalized;
    this.allowlistExpiresAt = now + this.allowlistTtlMs;
    return normalized;
  }

  private async readResult(res: Response, tool: ResolvedHttpTool): Promise<HttpExecutionResult> {
    const status = res.status;
    if (status < 200 || status >= 300) {
      const { text } = await this.readLimited(res, ERROR_SNIPPET_CHARS + 512);
      const snippet = text.slice(0, ERROR_SNIPPET_CHARS).trim();
      return {
        error: snippet !== '' ? `HTTP ${status}：${snippet}` : `HTTP ${status}：请求失败`,
        displayName: tool.displayName,
      };
    }
    const contentType = res.headers.get('content-type') ?? '';
    const baseType = contentType.split(';')[0]!.trim().toLowerCase();
    if (!isTextualContentType(baseType)) {
      // 二进制响应不硬转文本（乱码入上下文），返回可读提示
      return {
        status,
        body: '',
        truncated: false,
        displayName: tool.displayName,
        notice: `响应内容类型为 ${baseType === '' ? '未知' : baseType}，当前仅支持文本/JSON 响应`,
      };
    }
    const { text, truncated } = await this.readLimited(res, RESPONSE_MAX_BYTES);
    return { status, body: text, truncated, displayName: tool.displayName };
  }

  /** 流式读 + 读满即断（对齐 open-web-page-tool 截断范式）；读流异常按已读部分返回。 */
  private async readLimited(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    if (res.body == null) {
      return { text: '', truncated: false };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value == null || value.length === 0) continue;
        const room = maxBytes - size;
        if (room <= 0) {
          truncated = true;
          break;
        }
        if (value.length > room) {
          chunks.push(value.subarray(0, room));
          size = maxBytes;
          truncated = true;
          break;
        }
        chunks.push(value);
        size += value.length;
      }
    } catch {
      truncated = true;
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* 读流已中断时 cancel 可能 reject，忽略 */
      }
    }
    const text = chunks.length === 0
      ? ''
      : Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString('utf8');
    return { text, truncated };
  }
}

/** 文本 / JSON 内容类型放行（空 content-type 宽松按文本处理）。 */
function isTextualContentType(baseType: string): boolean {
  if (baseType === '') return true;
  return baseType.startsWith('text/')
    || baseType === 'application/json'
    || baseType.endsWith('+json')
    || baseType === 'application/xml'
    || baseType === 'text/xml';
}

function buildHeaders(tool: ResolvedHttpTool, withBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': DEFAULT_USER_AGENT,
  };
  if (withBody) {
    headers['Content-Type'] = 'application/json';
  }
  // 用户头覆盖默认头；敏感键值仅来自加密存储解密（调用方已解密为明文）
  Object.assign(headers, tool.headers);
  return headers;
}

function renderBodyTemplate(
  template: string,
  params: HttpToolParam[],
  args: Record<string, unknown>,
): string {
  // 单遍替换（String.replace 函数式不再扫替换结果），参数值里的 {{ 不递归展开
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    const param = params.find((item) => item.name === name);
    if (param == null) return match; // 未声明的占位符原样保留
    const value = args[name];
    if (value !== undefined && value !== null) return String(value);
    if (param.defaultValue != null) return param.defaultValue;
    return match;
  });
}

/**
 * URL 模板渲染：查询串 / 路径里的 {{参数名}} 替换为参数值（encodeURIComponent，
 * 避免值里的 & # ? 破坏 URL 结构；未声明的占位符原样保留由后续 URL 校验兜底）。
 * 与 body 模板同源的取值口径：实参 > 默认值 > 原样保留。
 */
function renderUrlTemplate(
  url: string,
  params: HttpToolParam[],
  args: Record<string, unknown>,
): string {
  return url.replace(PLACEHOLDER_RE, (match, name: string) => {
    const param = params.find((item) => item.name === name);
    if (param == null) return match;
    const value = args[name];
    if (value !== undefined && value !== null) return encodeURIComponent(String(value));
    if (param.defaultValue != null) return encodeURIComponent(param.defaultValue);
    return match;
  });
}

function parseArgsObject(argumentsJson: string | null | undefined): { value: Record<string, unknown> } | { error: string } {
  const trimmed = (argumentsJson ?? '').trim();
  if (trimmed === '') return { value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: '参数不是合法 JSON，请重新生成参数后重试' };
  }
  if (parsed == null) return { value: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: '参数必须是 JSON 对象' };
  }
  return { value: parsed as Record<string, unknown> };
}

/** 参数契约校验：必填缺失 / 类型不符 / 未定义参数均返回可读错误引导重试。 */
export function validateArguments(params: HttpToolParam[], args: Record<string, unknown>): string | null {
  const defined = new Set(params.map((param) => param.name));
  for (const key of Object.keys(args)) {
    if (!defined.has(key)) {
      return `存在未定义的参数 ${key}；请先用 http_describe 查询该工具的参数定义后重试`;
    }
  }
  for (const param of params) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required === 1) {
        return `缺少必填参数 ${param.name}（${param.label}）`;
      }
      continue;
    }
    if (param.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `参数 ${param.name} 应为 number`;
      }
    } else if (param.type === 'boolean') {
      if (typeof value !== 'boolean') {
        return `参数 ${param.name} 应为 boolean（true/false）`;
      }
    } else if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return `参数 ${param.name} 应为 string`;
    }
  }
  return null;
}

/** 网络错误归一化：不拼 URL、不回响应体全量（对齐 signal/probe-client 脱敏口径）。 */
function normalizeNetworkError(e: unknown, timeoutMs: number): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } } | null;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `请求失败：请求超时（${timeoutMs}ms）`;
  }
  const code = err?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return '请求失败：无法解析目标主机名';
  }
  if (code === 'ECONNREFUSED') {
    return '请求失败：目标主机拒绝连接';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `请求失败：连接超时（${timeoutMs}ms）`;
  }
  const message = (err?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return message !== '' ? `请求失败：${message}` : '请求失败：网络错误';
}
