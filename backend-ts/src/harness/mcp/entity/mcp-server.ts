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

export interface McpToolRef {
  serverId: number;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fullToolName?: string;
}

export function fullToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** OpenAI-compatible providers reject tool parameters whose JSON Schema `type` is null/missing. */
export function normalizeMcpInputSchema(schema: unknown): Record<string, unknown> {
  const root = asSchemaObject(schema);
  coerceSchemaType(root, 'object');
  if (root.properties == null || typeof root.properties !== 'object' || Array.isArray(root.properties)) {
    root.properties = {};
  }
  sanitizeSchemaTree(root);
  return root;
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
