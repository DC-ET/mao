import type { UploadTicketVO } from '@mao/contracts';

import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { CosSettings, ObsSettings, OssSettings, UploadSettings } from '../settings/types.js';
import { signCosRequest, signObsRequest, signOssRequest } from './storage-signer.js';

/** 票据有效期（秒）：写死不开放配置，防误配成超长有效期。 */
export const TICKET_EXPIRES_SECONDS = 600;

/** 直传仅面向图片附件，与前端图片 MIME 归一化（normalizeImageForUpload）口径一致。 */
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** key 中文件名长度上限（超出截断，保后缀语义由前端归一化保证）。 */
const KEY_NAME_MAX_LENGTH = 60;

const PROVIDER_LABELS: Record<string, string> = {
  oss: '阿里云 OSS',
  cos: '腾讯云 COS',
  obs: '华为云 OBS',
};

export interface UploadTicketConfigs {
  oss: OssSettings | null;
  cos: CosSettings | null;
  obs: ObsSettings | null;
}

/** key 文件名段安全化：去路径分隔，仅保留 \w . -，其余折叠为下划线，空值回落 image。 */
export function sanitizeObjectKeyName(rawName: string | null | undefined): string {
  const name = (rawName ?? '').split(/[/\\]/).pop() ?? '';
  const cleaned = name.replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, KEY_NAME_MAX_LENGTH);
  return hasText(cleaned) ? cleaned : 'image';
}

export class UploadTicketService {
  constructor(
    private readonly getUploadConfig: () => Promise<UploadSettings>,
    private readonly getConfigs: () => Promise<UploadTicketConfigs>,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async generateTicket(userId: number, contentType: string | null | undefined, fileName: string | null | undefined): Promise<UploadTicketVO> {
    const storageMode = (await this.getUploadConfig()).storageMode;
    if (storageMode === 'local') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '当前为本地存储模式，图片经服务端接口上传，无需申请上传票据');
    }
    // 保留调用方声明的原始 MIME（仅 trim）：OBS 的 Content-Type 参与预签名，
    // 前端 PUT 携带的正是它签发票据时声明的同一个值，签发时改写大小写会导致
    // 签名不一致被对象存储拒绝；白名单校验按小写比较。
    const mime = (contentType ?? '').trim() || 'image/jpeg';
    if (!ALLOWED_IMAGE_MIMES.has(mime.toLowerCase())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传票据仅支持图片附件（PNG/JPG/GIF/WebP）');
    }
    const now = this.nowMs();
    const key = `uploads/${userId}/${now}_${sanitizeObjectKeyName(fileName)}`;
    const configs = await this.getConfigs();
    const label = PROVIDER_LABELS[storageMode];
    if (label == null) {
      throw new BusinessException(5000, `未知的上传存储模式: ${storageMode}`);
    }
    let result: { uploadUrl: string; publicUrl: string };
    if (storageMode === 'oss') {
      if (configs.oss == null) throw notConfigured(label);
      result = signOssRequest(configs.oss, 'PUT', key, TICKET_EXPIRES_SECONDS, now);
    } else if (storageMode === 'cos') {
      if (configs.cos == null) throw notConfigured(label);
      result = signCosRequest(configs.cos, 'PUT', key, TICKET_EXPIRES_SECONDS, now);
    } else {
      if (configs.obs == null) throw notConfigured(label);
      result = signObsRequest(configs.obs, 'PUT', key, TICKET_EXPIRES_SECONDS, now, mime);
    }
    return {
      uploadUrl: result.uploadUrl,
      key,
      publicUrl: result.publicUrl,
      expiration: new Date(now + TICKET_EXPIRES_SECONDS * 1000).toISOString(),
    };
  }
}

function notConfigured(label: string): BusinessException {
  return new BusinessException(5001, `${label}未配置，请在管理后台"系统设置→集成配置"中填写`);
}
