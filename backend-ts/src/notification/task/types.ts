import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';

export type NotificationChannel = 'DINGTALK' | 'FEISHU';

export const DeliveryStatus = {
  WAITING_WS: 'WAITING_WS',
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  SUPPRESSED_WS: 'SUPPRESSED_WS',
} as const;

export function parseNotificationChannel(value: string | null | undefined): NotificationChannel {
  if (value == null || value.trim() === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '请选择通知渠道');
  }
  const upper = value.trim().toUpperCase();
  if (upper === 'DINGTALK' || upper === 'FEISHU') {
    return upper;
  }
  throw new BusinessException(ErrorCode.PARAM_INVALID, '通知渠道只支持 DINGTALK 或 FEISHU');
}

export interface UserTaskNotificationPreference {
  id?: number;
  userId: number;
  enabled?: number | null;
  channel?: string | null;
  webhookCiphertext?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface TaskNotificationDelivery {
  id?: number;
  eventKey?: string;
  userId?: number;
  sessionId?: number;
  executionId?: string;
  terminalPhase?: string;
  channel?: string;
  webhookCiphertext?: string;
  titleSnapshot?: string;
  failureReason?: string | null;
  status?: string;
  attemptCount?: number;
  nextRetryAt?: string | null;
  lastHttpStatus?: number | null;
  lastProviderCode?: string | null;
  lastError?: string | null;
  sentAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PreferenceView {
  enabled: boolean;
  channel: string | null;
  webhookConfigured: boolean;
  maskedWebhook: string | null;
}

export interface WebhookSendResult {
  success: boolean;
  retryable: boolean;
  httpStatus: number | null;
  providerCode: string | null;
  error: string | null;
}

export function webhookSuccess(httpStatus: number, providerCode: string | null): WebhookSendResult {
  return { success: true, retryable: false, httpStatus, providerCode, error: null };
}

export function webhookFailure(
  retryable: boolean,
  httpStatus: number | null,
  providerCode: string | null,
  error: string,
): WebhookSendResult {
  return { success: false, retryable, httpStatus, providerCode, error };
}

export const DEFAULT_NOTIFICATION_SECRET = 'mao-task-notification-default-key-v1-20260713';
