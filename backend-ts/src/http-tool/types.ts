/**
 * 自定义 HTTP 工具域类型与常量（docs/plan/2026-10-21-custom-http-tools-agent-scoped-technical-design.md §5.1）。
 * 定义态（管理员 CRUD）在此；运行态装配见 harness/core/custom-http-tools-catalog.ts，
 * 执行内核见 harness/tool/impl/http-api-executor.ts。
 * 归属模型：管理员配置 + 按 Agent 关联（agent.http_tool_ids），无属主列。
 */

/** 工具名 slug：小写字母开头，小写字母/数字/下划线，总长 ≤64。 */
export const HTTP_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** 参数名 slug：http_call arguments 的键，允许大写开头（camelCase 友好）。 */
export const HTTP_TOOL_PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 只读预推断方法：GET/HEAD 新建时 read_only 默认 1，其余默认 0。 */
const READ_ONLY_METHODS = new Set<string>(['GET', 'HEAD']);

/** 响应截断字节数（64KB，读满即断，对齐 open_web_page 截断范式）。 */
export const RESPONSE_MAX_BYTES = 64 * 1024;
/** http_call 入参 arguments JSON 大小上限（64KB，防模型灌入超大对象）。 */
export const ARGUMENTS_MAX_BYTES = 64 * 1024;
/** 超时钳制范围（毫秒）。 */
export const TIMEOUT_MIN_MS = 1000;
export const TIMEOUT_MAX_MS = 60000;
export const TIMEOUT_DEFAULT_MS = 15000;

/** description 列上限 1000 字；目录分节与 describe 回显统一截断到 200 字（防分节膨胀）。 */
export const DESCRIPTION_MAX_CHARS = 1000;
export const DESCRIPTION_CATALOG_CHARS = 200;

/** 敏感请求头键名判定（大小写不敏感子串）：token/secret/key/authorization/cookie。 */
export const SENSITIVE_HEADER_RE = /token|secret|key|authorization|cookie/i;
/** 回显掩码：与系统设置 secret 掩码同形。 */
export const HEADER_VALUE_MASK = '******';

/** 每工具参数 / 请求头数量上限（防滥用）。 */
export const MAX_PARAMS_PER_TOOL = 50;
export const MAX_HEADERS_PER_TOOL = 20;

/**
 * 工具名排序比较器（JS code-unit 序，非数据库 collation 序）。
 * 目录排序（harness/core/custom-http-tools-catalog.ts）使用：MySQL utf8mb4_0900_ai_ci
 * 把 `_` 排在数字前，与 JS 序相反，目录排序必须在 JS 侧做（防抖动）。
 */
export function compareHttpToolName(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
export const HEADER_KEY_MAX_CHARS = 64;
export const HEADER_VALUE_MAX_CHARS = 4096;
/** body 模板长度上限（纯文本替换模板，非递归）。 */
export const BODY_TEMPLATE_MAX_CHARS = 64 * 1024;

/** 工具自身两个入口名（保留字，slug 不得占用）。 */
export const HTTP_TOOL_NAMES = ['http_describe', 'http_call'] as const;
/** MCP 全量模式命名空间（保留字前缀）。 */
export const MCP_TOOL_NAMESPACE_PREFIX = 'mcp__';

export const HTTP_TOOL_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export type HttpToolParamType = (typeof HTTP_TOOL_PARAM_TYPES)[number];

export interface HttpTool {
  id?: number;
  /** slug：调用与目录分节使用的唯一标识（全局唯一）。 */
  name: string;
  displayName: string;
  description: string;
  method: string;
  url: string;
  /** JSON 对象；敏感值以 `enc:` 前缀密文存储，非敏感值明文。 */
  headersJson: string | null;
  bodyTemplate: string | null;
  readOnly: number;
  timeoutMs: number;
  enabled: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface HttpToolParam {
  id?: number;
  toolId: number;
  name: string;
  label: string;
  type: string;
  required: number;
  defaultValue: string | null;
  sortOrder: number;
}

export interface HttpToolWithParams {
  tool: HttpTool;
  params: HttpToolParam[];
}

/** 列表 / 编辑回显 VO：请求头敏感值打码，不出密文。 */
export interface HttpToolHeaderVO {
  key: string;
  value: string;
  sensitive: boolean;
}

export interface HttpToolParamVO {
  id?: number;
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string | null;
  sortOrder: number;
}

export interface HttpToolVO {
  id?: number;
  name: string;
  displayName: string;
  description: string;
  method: string;
  url: string;
  headers: HttpToolHeaderVO[];
  bodyTemplate: string | null;
  readOnly: boolean;
  timeoutMs: number;
  enabled: boolean;
  params: HttpToolParamVO[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 新建 / 编辑入参（路由 → service）。headers 为完整替换语义；敏感值传掩码视为不修改。 */
export interface HttpToolParamInput {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | null;
}

export interface HttpToolDraft {
  name: string;
  displayName: string;
  description: string;
  method: string;
  url: string;
  headers?: Record<string, string> | null;
  bodyTemplate?: string | null;
  readOnly?: boolean;
  timeoutMs?: number;
  enabled?: boolean;
  params?: HttpToolParamInput[];
}

/** 试运行入参：完整草稿 + 本次 arguments（不落库）。 */
export interface HttpToolTestDraft extends HttpToolDraft {
  arguments?: unknown;
}

/** 执行内核输入：已解密明文请求头的最终定义（落库行或草稿均可）。 */
export interface ResolvedHttpTool {
  name: string;
  displayName: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyTemplate: string | null;
  timeoutMs: number;
}

export interface ResolvedHttpToolExecution {
  tool: ResolvedHttpTool;
  params: HttpToolParam[];
}

export interface HttpToolRepository {
  /** 按 id 集合取启用工具（Agent 装配用；空集合由调用方短路，不进 SQL）。 */
  listEnabledByIds(ids: number[]): Promise<HttpTool[]>;
  findById(id: number): Promise<HttpTool | null>;
  findByName(name: string): Promise<HttpTool | null>;
  listParamsByToolId(toolId: number): Promise<HttpToolParam[]>;
  insert(tool: HttpTool): Promise<number>;
  updateById(tool: HttpTool): Promise<void>;
  deleteById(id: number): Promise<void>;
  insertParam(param: HttpToolParam): Promise<number>;
  deleteParamsByToolId(toolId: number): Promise<void>;
  /** 事务内执行（建/改/删跨两表，任一失败整体回滚）。 */
  transaction<T>(fn: (repo: HttpToolRepository) => Promise<T>): Promise<T>;
  /** 管理侧清单：keyword 匹配工具名/展示名，enabled 过滤启用态（无属主维度）。 */
  listForAdmin(
    page: number,
    size: number,
    query: AdminHttpToolQuery,
  ): Promise<{ rows: AdminHttpToolRow[]; total: number }>;
  /** 启用工具轻量列表（Agent 表单下拉用）。 */
  listEnabledBrief(): Promise<Array<Pick<HttpTool, 'id' | 'name' | 'displayName' | 'method' | 'readOnly'>>>;
}

/** 管理侧清单行（无属主维度）。 */
export type AdminHttpToolRow = HttpTool;

export interface AdminHttpToolQuery {
  keyword?: string | null;
  enabled?: boolean | null;
}

/** 系统设置端口（http-tool 域不直接依赖 settings 域实现）。 */
export interface HttpToolSettingsPort {
  getPrivateAllowlistCidrs(): Promise<string[]>;
}

/** Agent 关联校验端口（HttpToolValidatorImpl 满足；由 agent.routes 注入使用）。 */
export interface HttpToolValidator {
  /**
   * @param ids 本次提交的关联 id（去重后返回）
   * @param existingIds 编辑前的存量关联：其中的失效 id（已停用/已删除）保留，
   *   只对新增 id 校验存在性与启用态，避免失效关联阻塞 Agent 的其它字段编辑。
   */
  validateForAgent(ids: number[], existingIds?: readonly number[]): Promise<number[]>;
}

/** 内置工具名提供者（保留字校验用；由 ToolRegistry 装配层注入，避免循环依赖）。 */
export type BuiltinToolNamesProvider = () => string[];

/** 请求头加解密（敏感值 AES-GCM，对齐 MCP env / 哨兵凭据口径）。 */
export interface HttpToolSecretCipher {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export function isSensitiveHeaderKey(key: string): boolean {
  return SENSITIVE_HEADER_RE.test(key);
}

/** GET/HEAD 预推断只读；其余方法一律可写（编辑器可改，服务端不强转）。 */
export function inferReadOnlyByMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method.trim().toUpperCase());
}

export function clampTimeoutMs(timeoutMs: number | undefined | null): number {
  if (timeoutMs == null || !Number.isFinite(timeoutMs)) return TIMEOUT_DEFAULT_MS;
  const n = Math.round(Number(timeoutMs));
  if (!Number.isFinite(n)) return TIMEOUT_DEFAULT_MS;
  return Math.min(TIMEOUT_MAX_MS, Math.max(TIMEOUT_MIN_MS, n));
}

/** 目录分节 / describe 回显统一截断（§8 风险 4 / §9.6）。 */
export function truncateToolDescription(text: string | null | undefined, max = DESCRIPTION_CATALOG_CHARS): string {
  const value = (text ?? '').trim();
  return value.length <= max ? value : value.slice(0, max);
}

/** slug 保留字校验：内置工具名 + mcp__ 命名空间 + 两个入口工具自身。 */
export function isReservedToolName(name: string, builtinNames: readonly string[]): boolean {
  if (name.startsWith(MCP_TOOL_NAMESPACE_PREFIX)) return true;
  if ((HTTP_TOOL_NAMES as readonly string[]).includes(name)) return true;
  return builtinNames.includes(name);
}

/**
 * 解析 Agent 关联的工具 id 列表（agent.http_tool_ids，JSON 数组）。
 * 空 / 缺失 / 非法 JSON → 空数组；过滤非正整数 id（防脏数据进 SQL IN）。
 * 镜像 mcp-sync-service 的 parseAgentServerIds 口径。
 */
export function parseHttpToolIds(agent: { httpToolIds?: string | null } | null | undefined): number[] {
  const raw = agent?.httpToolIds;
  if (raw == null || raw.trim() === '') return [];
  try {
    const ids = JSON.parse(raw) as unknown;
    if (!Array.isArray(ids)) return [];
    return ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  } catch {
    return [];
  }
}
