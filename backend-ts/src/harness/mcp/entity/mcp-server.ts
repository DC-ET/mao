export const TYPE_STDIO = 'STDIO';
export const TYPE_HTTP = 'HTTP';
export const STATUS_ENABLED = 'ENABLED';
export const STATUS_DISABLED = 'DISABLED';
export const GLOBAL_USER_ID = 0;

export interface McpServer {
  id?: number;
  userId?: number;
  name?: string;
  description?: string | null;
  serverType?: string;
  command?: string | null;
  argsJson?: string | null;
  url?: string | null;
  envJson?: string | null;
  status?: string;
  deleted?: number;
  userName?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface McpToolAnnotations {
  /** MCP tools/list 标准字段：为 true 表示该工具不修改外部状态。 */
  readOnlyHint?: boolean;
}

export interface McpToolRef {
  serverId: number;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fullToolName?: string;
  /** 工具注解（仅消费 readOnlyHint：工作集清单标记 + 审批免审）。 */
  annotations?: McpToolAnnotations | null;
}

/** 某台 server 本次连接失败的结构化信息（工作集需标注「当前不可用」）。 */
export interface McpConnectionError {
  serverId: number | null;
  serverName: string;
  reason: string;
}

/**
 * 只保留工作集与审批会消费的字段：读快照 / 桌面上报 / 容器三条来源都经此处归一，
 * 保证同一工具在多来源下产出相同结构（前缀缓存要求文本稳定）。
 * 未标注 readOnlyHint 时返回 null，避免把上游的任意扩展注解带进内存。
 */
export function normalizeMcpAnnotations(raw: unknown): McpToolAnnotations | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if ((raw as { readOnlyHint?: unknown }).readOnlyHint !== true) return null;
  return { readOnlyHint: true };
}

export function fullToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** OpenAI-compatible providers reject tool parameters whose JSON Schema `type` is null/missing. */
export function normalizeMcpInputSchema(schema: unknown): Record<string, unknown> {
  const root = normalizeRootCombinator(asSchemaObject(schema));
  coerceSchemaType(root, 'object');
  if (root.properties == null || typeof root.properties !== 'object' || Array.isArray(root.properties)) {
    root.properties = {};
  }
  sanitizeSchemaTree(root);
  return root;
}

/** Some providers reject oneOf/anyOf/allOf when it is the tool schema itself. */
function normalizeRootCombinator(schema: Record<string, unknown>): Record<string, unknown> {
  const combinator = ['anyOf', 'oneOf', 'allOf'].find((key) => Array.isArray(schema[key]));
  if (!combinator) return schema;

  const branches = (schema[combinator] as unknown[])
    .filter((branch): branch is Record<string, unknown> =>
      branch != null && typeof branch === 'object' && !Array.isArray(branch));
  const propertyVariants = branches
    .map((branch) => branch.properties)
    .filter((properties): properties is Record<string, unknown> =>
      properties != null && typeof properties === 'object' && !Array.isArray(properties));
  const properties: Record<string, unknown> = {};
  for (const variant of propertyVariants) Object.assign(properties, variant);

  const requiredVariants = branches.map((branch) => (
    Array.isArray(branch.required) ? branch.required.filter((value): value is string => typeof value === 'string') : []
  ));
  let required: string[] = [];
  if (requiredVariants.length > 0) {
    if (combinator === 'allOf') {
      required = [...new Set(requiredVariants.flat())];
    } else {
      required = requiredVariants[0].filter((name) => requiredVariants.every((variant) => variant.includes(name)));
    }
  }

  const normalized: Record<string, unknown> = { ...schema, type: 'object', properties };
  delete normalized.anyOf;
  delete normalized.oneOf;
  delete normalized.allOf;
  delete normalized.enum;
  delete normalized.const;
  if (required.length > 0) normalized.required = required;
  else delete normalized.required;
  return normalized;
}

function asSchemaObject(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return { ...(schema as Record<string, unknown>) };
  }
  return { type: 'object', properties: {} };
}

function coerceSchemaType(node: Record<string, unknown>, fallback: string): void {
  const t = node.type;
  if (t == null || t === 'null') {
    node.type = fallback;
    return;
  }
  if (Array.isArray(t)) {
    const filtered = t.filter((item) => item != null && item !== 'null');
    if (!filtered.includes(fallback) && fallback === 'object' && !node.properties) {
      /* keep union as-is after dropping null */
    }
    node.type = filtered.length === 0 ? fallback : filtered.length === 1 ? filtered[0] : filtered;
  }
}

function sanitizeSchemaTree(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) sanitizeSchemaTree(item);
    return;
  }
  const obj = node as Record<string, unknown>;
  if ('type' in obj) coerceSchemaType(obj, obj.properties ? 'object' : 'string');
  if (obj.properties && typeof obj.properties === 'object' && !Array.isArray(obj.properties)) {
    for (const value of Object.values(obj.properties as Record<string, unknown>)) sanitizeSchemaTree(value);
  }
  sanitizeSchemaTree(obj.items);
  sanitizeSchemaTree(obj.anyOf);
  sanitizeSchemaTree(obj.oneOf);
  sanitizeSchemaTree(obj.allOf);
  if (obj.additionalProperties && typeof obj.additionalProperties === 'object') {
    sanitizeSchemaTree(obj.additionalProperties);
  }
}

export interface UserMcpPreference {
  id?: number;
  userId: number;
  serverId: number;
  enabled?: number;
}
