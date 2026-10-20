/**
 * 自定义 HTTP 工具域类型与常量（docs/plan/2026-10-19-custom-http-tools-technical-design.md §5.1）。
 * 定义态（用户 CRUD）在此；运行态装配见 harness/core/custom-http-tools-catalog.ts，
 * 执行内核见 harness/tool/impl/http-api-executor.ts。
 */

/** 工具名 slug：小写字母开头，小写字母/数字/下划线，总长 ≤64。 */
export const USER_TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
/** 参数名 slug：http_call arguments 的键，允许大写开头（camelCase 友好）。 */
export const USER_TOOL_PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** 只读预推断方法：GET/HEAD 新建时 read_only 默认 1，其余默认 0。 */
const READ_ONLY_METHODS = new Set<string>(['GET', 'HEAD']);

/** 单用户启用上限默认值（系统设置 tools.http.maxEnabledPerUser 可配）。 */
export const MAX_ENABLED_DEFAULT = 20;
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
 * 目录截断（harness/core/custom-http-tools-catalog.ts）与可调用名次
 * （user-tool.service.ts findCallableEnabled）共用同一比较器：两侧必须同序，
 * 否则「目录里看得见却调不动 / 目录外看不见却调得通」的分歧会随上限边界出现
 * （MySQL utf8mb4_0900_ai_ci 把 `_` 排在数字前，与 JS 序相反）。
 */
export function compareUserToolName(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}
export const HEADER_KEY_MAX_CHARS = 64;
export const HEADER_VALUE_MAX_CHARS = 4096;
/** body 模板长度上限（纯文本替换模板，非递归）。 */
export const BODY_TEMPLATE_MAX_CHARS = 64 * 1024;

/** 工具自身两个入口名（保留字，用户 slug 不得占用）。 */
export const HTTP_TOOL_NAMES = ['http_describe', 'http_call'] as const;
/** MCP 全量模式命名空间（保留字前缀）。 */
export const MCP_TOOL_NAMESPACE_PREFIX = 'mcp__';

export const USER_TOOL_PARAM_TYPES = ['string', 'number', 'boolean'] as const;
export type UserToolParamType = (typeof USER_TOOL_PARAM_TYPES)[number];

export interface UserTool {
  id?: number;
  userId: number;
  /** slug：调用与目录分节使用的唯一标识（属主内唯一）。 */
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

export interface UserToolParam {
  id?: number;
  toolId: number;
  name: string;
  label: string;
  type: string;
  required: number;
  defaultValue: string | null;
  sortOrder: number;
}

export interface UserToolWithParams {
  tool: UserTool;
  params: UserToolParam[];
}

/** 列表 / 编辑回显 VO：请求头敏感值打码，不出密文。 */
export interface UserToolHeaderVO {
  key: string;
  value: string;
  sensitive: boolean;
}

export interface UserToolParamVO {
  id?: number;
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: string | null;
  sortOrder: number;
}

export interface UserToolVO {
  id?: number;
  name: string;
  displayName: string;
  description: string;
  method: string;
  url: string;
  headers: UserToolHeaderVO[];
  bodyTemplate: string | null;
  readOnly: boolean;
  timeoutMs: number;
  enabled: boolean;
  params: UserToolParamVO[];
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 新建 / 编辑入参（路由 → service）。headers 为完整替换语义；敏感值传掩码视为不修改。 */
export interface UserToolParamInput {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
  defaultValue?: string | null;
}

export interface UserToolDraft {
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
  params?: UserToolParamInput[];
}

/** 试运行入参：完整草稿 + 本次 arguments（不落库）。 */
export interface UserToolTestDraft extends UserToolDraft {
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
  params: UserToolParam[];
}

export interface UserToolRepository {
  listByUserId(userId: number): Promise<UserTool[]>;
  listEnabledByUserId(userId: number): Promise<UserTool[]>;
  findById(id: number): Promise<UserTool | null>;
  findByIdAndUserId(id: number, userId: number): Promise<UserTool | null>;
  findByUserIdAndName(userId: number, name: string): Promise<UserTool | null>;
  countEnabledByUserId(userId: number): Promise<number>;
  listParamsByToolId(toolId: number): Promise<UserToolParam[]>;
  insert(tool: UserTool): Promise<number>;
  updateById(tool: UserTool): Promise<void>;
  deleteById(id: number): Promise<void>;
  insertParam(param: UserToolParam): Promise<number>;
  deleteParamsByToolId(toolId: number): Promise<void>;
  /** 事务内执行（建/改/删跨两表，任一失败整体回滚）。 */
  transaction<T>(fn: (repo: UserToolRepository) => Promise<T>): Promise<T>;
}

/** 管理侧清单行（带属主展示名）。 */
export interface AdminUserToolRow extends UserTool {
  username: string | null;
  userDisplayName: string | null;
}

export interface AdminUserToolQuery {
  keyword?: string | null;
  username?: string | null;
  enabled?: boolean | null;
}

export interface AdminUserToolRepository {
  listForAdmin(
    page: number,
    size: number,
    query: AdminUserToolQuery,
  ): Promise<{ rows: AdminUserToolRow[]; total: number }>;
}

/** 系统设置端口（user-tool 域不直接依赖 settings 域实现）。 */
export interface UserToolSettingsPort {
  getMaxEnabledPerUser(): Promise<number>;
  getPrivateAllowlistCidrs(): Promise<string[]>;
}

/** 内置工具名提供者（保留字校验用；由 ToolRegistry 装配层注入，避免循环依赖）。 */
export type BuiltinToolNamesProvider = () => string[];

/** 请求头加解密（敏感值 AES-GCM，对齐 MCP env / 哨兵凭据口径）。 */
export interface UserToolSecretCipher {
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
