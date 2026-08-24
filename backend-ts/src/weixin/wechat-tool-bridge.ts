import type { WeixinAccountRepository } from './account.repository.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { WeixinMediaToolSupport } from './media-tool-support.js';
import type { WeixinMediaUploadService } from './media-upload.service.js';
import type { WeixinSendService } from './send.service.js';
import type { CdnMedia } from './types.js';
import type {
  WeixinMediaToolSupport as ToolSupport,
  WeixinMediaUploadService as ToolUpload,
  WeixinSendService as ToolSend,
} from '../harness/tool/impl/wechat-tools.js';

function parseMedia(mediaId: string): CdnMedia {
  try {
    return JSON.parse(mediaId) as CdnMedia;
  } catch {
    throw new Error('无效的微信媒体引用');
  }
}

export function createWechatToolBridges(
  support: WeixinMediaToolSupport,
  upload: WeixinMediaUploadService,
  send: WeixinSendService,
  accountRepository: WeixinAccountRepository,
  tokenRepository: ContextTokenRepository,
): { toolSupport: ToolSupport; uploadService: ToolUpload; sendService: ToolSend } {
  return {
    toolSupport: {
      async resolveAccount(sessionId, userId) {
        const target = await support.resolveTarget(userId, sessionId);
        return target == null ? null : { accountId: target.accountId, wxUserId: target.wxUserId };
      },
    },
    uploadService: {
      async uploadImage(accountId, wxUserId, bytes) {
        const account = await accountRepository.findByAccountId(accountId);
        if (account == null) throw new Error('微信账号不存在');
        const media = await upload.uploadImage(account, wxUserId, bytes);
        if (media == null) throw new Error('微信图片上传失败');
        return { mediaId: JSON.stringify(media) };
      },
      async uploadFile(accountId, wxUserId, bytes, _fileName) {
        const account = await accountRepository.findByAccountId(accountId);
        if (account == null) throw new Error('微信账号不存在');
        const media = await upload.uploadFile(account, wxUserId, bytes);
        if (media == null) throw new Error('微信文件上传失败');
        return { mediaId: JSON.stringify(media) };
      },
    },
    sendService: {
      sendImage(accountId, wxUserId, mediaId) {
        return send.sendImage(accountId, wxUserId, parseMedia(mediaId));
      },
      sendFile(accountId, wxUserId, mediaId, fileName) {
        return send.sendFile(accountId, wxUserId, parseMedia(mediaId), fileName);
      },
    },
  };
}
