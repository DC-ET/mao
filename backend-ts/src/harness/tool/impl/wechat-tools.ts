/**
 * 微信通道发送的支撑接口（技术方案 2026-11-18-unified-send-media）：
 * 六个旧发送工具类已收编为 send_image / send_file 的微信策略（send-media-tool.ts），
 * 这里只保留装配层与策略共用的接口契约。
 */

export interface WeixinMediaToolSupport {
  resolveAccount(sessionId: number | null, userId: number | null): Promise<{ accountId: string; wxUserId: string } | null>;
}

export interface WeixinMediaUploadService {
  uploadImage(accountId: string, wxUserId: string, bytes: Buffer, mime: string): Promise<{ mediaId: string }>;
  uploadFile(accountId: string, wxUserId: string, bytes: Buffer, fileName: string, mime: string): Promise<{ mediaId: string }>;
}

export interface WeixinSendService {
  sendImage(accountId: string, wxUserId: string, mediaId: string): Promise<boolean>;
  sendFile(accountId: string, wxUserId: string, mediaId: string, fileName: string): Promise<boolean>;
}
