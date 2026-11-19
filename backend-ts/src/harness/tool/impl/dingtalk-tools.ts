/**
 * 钉钉通道发送的支撑接口（技术方案 2026-11-18-unified-send-media）：
 * 两个旧发送工具类已收编为 send_image / send_file 的钉钉策略（send-media-tool.ts），
 * 这里只保留装配层与策略共用的接口契约。
 */

export interface DingtalkSendTarget {
  chatType: 'p2p' | 'group';
  robotCode: string;
  userId?: string;
  conversationId?: string;
  clientId: string;
  clientSecret: string;
}

export interface DingtalkMediaSendSupport {
  resolveSendTarget(sessionId: number | null): Promise<DingtalkSendTarget | null>;
  sendImage(target: DingtalkSendTarget, bytes: Buffer, fileName: string): Promise<string>;
  sendFile(target: DingtalkSendTarget, fileName: string, bytes: Buffer): Promise<string>;
}
