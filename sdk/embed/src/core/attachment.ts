/**
 * 剪切板附件：粘贴得到的图片/文件先暂存在输入区，发送时上传到 Mao 服务再随消息发出。
 * - 图片：POST /files/upload → url，作为 WS `data.images` 交给多模态模型
 * - 其他文件：POST /files/upload-incoming → absolutePath，拼成 `@{绝对路径}@` 引用写进正文
 * 宿主页面不提供上传按钮，也不接触 Token。
 */

/** 单条消息最多附件数（与桌面端 ChatInput 一致） */
export const MAX_ATTACHMENTS = 10;
/** 拿不到后台上传配置时的兜底大小上限（MB），与桌面端 getUploadConfig 兜底一致 */
export const DEFAULT_MAX_ATTACHMENT_MB = 1024;

/** 输入区内待发附件 */
export interface PendingAttachment {
  id: string;
  file: File;
  /** 图片的本地预览 object URL；非图片为 null */
  previewUrl: string | null;
}

/** 附件上传/配置读取所需的最小客户端能力（RestClient 已满足） */
export interface AttachmentRestClient {
  request<T>(method: 'GET' | 'POST', path: string): Promise<T>;
  upload<T>(path: string, form: FormData): Promise<T>;
}

export interface UploadedAttachments {
  /** 图片访问 URL（已按 Mao 服务域名补全为绝对地址） */
  images: string[];
  /** 非图片文件的 `@{绝对路径}@` 引用 */
  refs: string[];
  /** 上传失败的文件名 */
  failed: string[];
}

export function isImageAttachment(file: File): boolean {
  return file.type.startsWith('image/');
}

export function attachmentFileName(file: File): string {
  const name = file.name?.trim();
  if (name) return name;
  return isImageAttachment(file) ? '图片' : '文件';
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function createPendingAttachment(file: File): PendingAttachment {
  return {
    id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    file,
    // 只有图片需要缩略图；非图片给 null，避免为每个文件创建无用 object URL
    previewUrl: isImageAttachment(file) ? URL.createObjectURL(file) : null,
  };
}

/**
 * 从粘贴事件取出文件。纯文本粘贴返回空数组，由浏览器照常插入输入框。
 * 图片在剪切板里同样是 kind='file' 的 item；data.files 仅作 items 缺失（旧内核）时的兜底。
 */
export function collectPastedFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const items = data.items;
  if (items) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.kind !== 'file') continue;
      const file = item.getAsFile?.();
      if (file) out.push(file);
    }
  }
  if (out.length === 0 && data.files) out.push(...Array.from(data.files));
  return out;
}

/** 读取后台配置的附件大小上限（MB）；失败或未配置时回退默认值，不阻断输入 */
export async function fetchMaxAttachmentMb(client: AttachmentRestClient): Promise<number> {
  try {
    const config = await client.request<{ maxSizeMb?: number }>('GET', '/upload/config');
    const value = Number(config?.maxSizeMb);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_ATTACHMENT_MB;
  } catch {
    return DEFAULT_MAX_ATTACHMENT_MB;
  }
}

/**
 * 逐个上传附件。单个失败不阻断其他附件（文件名记入 failed，由调用方提示），
 * 全部失败且无正文时调用方应放弃发送，避免把「只发了文字」当成成功。
 */
export async function uploadAttachments(opts: {
  attachments: PendingAttachment[];
  client: AttachmentRestClient;
  sessionId: number;
  /** 相对地址补全（本地存储模式下 /files/upload 会返回 /uploads/xxx） */
  resolveAssetUrl: (url: string) => string;
}): Promise<UploadedAttachments> {
  const result: UploadedAttachments = { images: [], refs: [], failed: [] };
  for (const attachment of opts.attachments) {
    const { file } = attachment;
    try {
      if (isImageAttachment(file)) {
        const form = new FormData();
        form.append('file', file);
        const data = await opts.client.upload<{ url?: string }>('/files/upload', form);
        if (!data?.url) throw new Error('missing url');
        result.images.push(opts.resolveAssetUrl(data.url));
      } else {
        const form = new FormData();
        form.append('file', file);
        form.append('sessionId', String(opts.sessionId));
        const data = await opts.client.upload<{ absolutePath?: string }>('/files/upload-incoming', form);
        if (!data?.absolutePath) throw new Error('missing absolutePath');
        result.refs.push(`@{${data.absolutePath}}@`);
      }
    } catch {
      result.failed.push(attachmentFileName(file));
    }
  }
  return result;
}
