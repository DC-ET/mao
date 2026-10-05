/**
 * 开放接口域共享类型（API Token / 入站 Webhook 触发器 / 出站事件订阅）。
 * 对应技术方案 docs/plan/2026-10-05-open-api-webhook-technical-design.md。
 */

/** openapi 域自有 scope 字典（不进 V121 permission 目录，见技术方案决策 5）；首期仅 open:run。 */
export const OPENAPI_SCOPES = ['open:run'] as const;
export type OpenApiScope = (typeof OPENAPI_SCOPES)[number];

/**
 * API Token 唯一生效的路径前缀（鉴权层单点强制）：携带 `mao_` token 的请求
 * 只有落在 `/v1/open/**` 下才解析身份，其余端点一律 401——
 * 防止泄露的 token 越权调用该用户的其它 REST 接口（技术方案 §5.2 不变式）。
 */
export const OPEN_API_PATH_PREFIX = '/v1/open/';

export function normalizeScopes(value: unknown): OpenApiScope[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is OpenApiScope => typeof v === 'string' && (OPENAPI_SCOPES as readonly string[]).includes(v));
}

export interface ApiToken {
  id?: number;
  userId?: number;
  name?: string;
  tokenPrefix?: string | null;
  tokenHash?: string | null;
  scopes?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type WebhookTriggerEventSource = 'WEBHOOK' | 'API';

export interface WebhookTrigger {
  id?: number;
  userId?: number;
  agentId?: number;
  /** NULL = 每次触发新建会话 */
  sessionId?: number | null;
  name?: string;
  pathToken?: string | null;
  secretCipher?: string | null;
  enabled?: number;
  consecutiveFailures?: number;
  lastFiredAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 出站事件（技术方案 §5.5）：任务完成/失败 + 提问待答。 */
export const OUTBOUND_EVENTS = ['task.completed', 'task.failed', 'question.pending'] as const;
export type OutboundEvent = (typeof OUTBOUND_EVENTS)[number];

export function isOutboundEvent(value: unknown): value is OutboundEvent {
  return typeof value === 'string' && (OUTBOUND_EVENTS as readonly string[]).includes(value);
}

export interface OutboundSubscription {
  id?: number;
  userId?: number;
  event?: string;
  targetUrl?: string | null;
  secretCipher?: string | null;
  enabled?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export type OutboundDeliveryStatus = 'PENDING' | 'SENDING' | 'SUCCEEDED' | 'FAILED';

export interface OutboundDelivery {
  id?: number;
  subscriptionId?: number;
  event?: string;
  payload?: string | null;
  status?: string;
  attemptCount?: number;
  nextRetryAt?: string | null;
  lastHttpStatus?: number | null;
  lastError?: string | null;
  createdAt?: string | null;
  sentAt?: string | null;
}

/** 管理列表响应形态（secret/哈希不出域）。 */
export interface ApiTokenView {
  id: number;
  name: string;
  tokenPrefix: string;
  scopes: OpenApiScope[];
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

export interface WebhookTriggerView {
  id: number;
  name: string;
  agentId: number;
  sessionId: number | null;
  enabled: boolean;
  url: string | null;
  consecutiveFailures: number;
  lastFiredAt: string | null;
  createdAt: string | null;
}

export interface OutboundSubscriptionView {
  id: number;
  event: OutboundEvent;
  targetUrl: string;
  enabled: boolean;
  createdAt: string | null;
}
