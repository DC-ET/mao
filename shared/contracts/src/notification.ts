/**
 * 任务通知相关契约。
 * 注意：只放类型，运行时解析/校验逻辑保留在后端 notification 模块。
 */
export type NotificationChannel = 'DINGTALK' | 'FEISHU';

export interface TaskNotificationPreference {
  enabled: boolean;
  channel: NotificationChannel | null;
  webhookConfigured: boolean;
  maskedWebhook: string | null;
}
