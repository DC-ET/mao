export interface WeixinBotConfig {
  enabled: boolean;
  voiceReply: boolean;
  silkEncoderPath: string;
  ffmpegPath: string;
  voiceMaxSeconds: number;
  ilinkBaseUrl: string;
  cdnBaseUrl: string;
  maxInboundFileMb: number;
  monitor: {
    enabled: boolean;
    reconcileIntervalMs: number;
    longPollTimeoutMs: number;
    maxConsecutiveFailures: number;
  };
}

export const DEFAULT_WEIXIN_BOT_CONFIG: WeixinBotConfig = {
  enabled: true,
  voiceReply: false,
  silkEncoderPath: '/usr/local/bin/silk-encoder',
  ffmpegPath: 'ffmpeg',
  voiceMaxSeconds: 300,
  ilinkBaseUrl: 'https://ilinkai.weixin.qq.com',
  cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
  maxInboundFileMb: 100,
  monitor: {
    enabled: true,
    reconcileIntervalMs: 5000,
    longPollTimeoutMs: 35000,
    maxConsecutiveFailures: 3,
  },
};

export const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

export interface WeixinChannelAccount {
  id?: number;
  userId?: number | null;
  accountId?: string | null;
  payloadJson?: string | null;
  getUpdatesBuf?: string | null;
  enabled?: number | null;
  deleted?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface WeixinChannelContextToken {
  id?: number;
  accountId?: string | null;
  wxUserId?: string | null;
  token?: string | null;
  deleted?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface QrcodeResponse {
  sessionKey: string;
  qrDataUrl: string;
  message: string;
}

export interface QrcodeStatusResponse {
  status: string;
  botToken?: string;
  baseUrl?: string;
  ilinkUserId?: string;
}

export interface BindingStatus {
  bound: boolean;
  accountId?: string | null;
  boundAt?: string | null;
}

export interface InboundFile {
  fileName: string;
  bytes: Buffer;
  mimeType: string;
}

export interface WeixinInboundMessageContext {
  accountId: string;
  fromUserId?: string;
  body: string;
  contextToken?: string | null;
  mediaPath?: string | null;
  mediaType?: string | null;
  imageDataUris?: string[];
  files?: InboundFile[];
  fileDownloadErrors?: string[];
  rawMessage?: unknown;
}

export interface WeixinReply {
  text?: string | null;
}

export interface WeixinInboundHandler {
  authorizeDirectMessage(accountId: string, fromUserId: string, text: string): boolean;
  onMessage(context: WeixinInboundMessageContext): Promise<WeixinReply | null>;
}

export interface CdnMedia {
  encryptQueryParam: string;
  aesKey: string;
  encryptType: number;
  size: number;
  rawSize: number;
  rawMd5: string;
}

export const WEIXIN_PROJECT_KEY = 'weixin-bot';
