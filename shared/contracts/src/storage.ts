/**
 * 图片附件上传存储模式（upload.storageMode）：
 * local=服务端磁盘；oss/cos/obs=对应云厂商对象存储（预签名 PUT 直传）。
 */
export type StorageMode = 'local' | 'oss' | 'cos' | 'obs';

/** 预签名上传票据：前端 PUT uploadUrl 直传对象后，以 publicUrl 引用图片。 */
export interface UploadTicketVO {
  /** 含签名的完整 PUT URL，票据有效期内可直传该对象。 */
  uploadUrl: string;
  /** 服务端生成的对象 key（uploads/{userId}/{ts}_{name}）。 */
  key: string;
  /** 上传成功后的公网访问 URL（bucket 公共读口径），直接写入消息。 */
  publicUrl: string;
  /** 票据过期时间（ISO 8601）。 */
  expiration: string;
}
