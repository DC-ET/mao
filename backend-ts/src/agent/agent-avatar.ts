import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import '@fastify/multipart';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AgentAvatarUploadVO } from '@mao/contracts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import type { FileEntity, FileService } from '../file/file.service.js';

export const AGENT_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 4096 * 4096;

function invalid(message: string): BusinessException {
  return new BusinessException(ErrorCode.PARAM_INVALID, message);
}

/** 头像对外 URL：按 filePath 相对上传根拼（2026-11-24 D7），与 file.routes 的 toVO 同口径。 */
function avatarUploadUrl(file: FileEntity, uploadDir: string): string {
  const rel = file.filePath != null && file.filePath !== ''
    ? relative(resolve(uploadDir), resolve(file.filePath))
    : '';
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) {
    return `/uploads/${rel.split(sep).join('/')}`;
  }
  return `/uploads/${file.storedName}`;
}

/**
 * 只接受同源上传路径（2026-11-24 D7 起两种形态都合法）：
 * - 存量：`/uploads/{uuid}.png`（上传根平坦目录，不搬迁）
 * - 新增：`/uploads/{数字用户 id}/{uuid}.png`（与文生图产物、对象存储 key 同口径）
 * 仍拒绝任何活动内容或远端 URL scheme。
 */
const AGENT_AVATAR_URL_PATTERNS = [
  /^\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
  /^\/uploads\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/,
];

export function validateAgentAvatarUrl(value: unknown): asserts value is string | null | undefined {
  if (value == null) return;
  if (typeof value !== 'string' || !AGENT_AVATAR_URL_PATTERNS.some((p) => p.test(value))) {
    throw invalid('头像地址必须为头像上传接口返回的 /uploads/ PNG 地址');
  }
}

/** Decode the entire image, then re-encode to remove metadata and trailing/active payloads. */
export async function normalizeAgentAvatar(bytes: Buffer, mime: string): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > AGENT_AVATAR_MAX_BYTES) {
    throw invalid('头像不能为空且不得超过 2 MiB');
  }
  const format = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'png'
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'jpeg'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'webp'
        : null;
  // Some WebViews (e.g. WeChat's built-in image editor) return files with an empty or
  // generic MIME type; trust the magic bytes instead and only reject explicit mismatches.
  const declared = mime !== '' && mime !== 'application/octet-stream' ? mime : null;
  if (!format || (declared && declared !== `image/${format}`)) throw invalid('头像仅支持 PNG、JPEG、WebP，类型必须与内容一致');
  // libvips may decode APNG as a still PNG, so reject its animation control chunk explicitly.
  if (format === 'png') {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') throw invalid('头像不支持动画');
      offset += length + 12;
    }
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1
      || !metadata.width || !metadata.height || metadata.width > 4096 || metadata.height > 4096) {
      throw new Error('Invalid dimensions or animated image');
    }
    return await image.rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw invalid('头像图片损坏、包含动画或尺寸超过 4096 × 4096');
  }
}

export function registerAgentAvatarRoutes(
  app: FastifyInstance,
  fileService: Pick<FileService, 'uploadFile' | 'getUploadDir'>,
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> },
): void {
  app.post('/v1/agents/avatar', async (request, reply) => {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, 'agent:write');
    if (!request.isMultipart()) throw invalid('请使用 multipart/form-data 上传 file 图片');
    let bytes: Buffer | undefined;
    let mime = '';
    try {
      for await (const part of request.parts({ limits: { fileSize: AGENT_AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 1 } })) {
        if (part.type !== 'file' || part.fieldname !== 'file') throw invalid('仅允许一个 file 图片字段');
        bytes = await part.toBuffer();
        if (part.file.truncated) throw invalid('头像不得超过 2 MiB');
        mime = part.mimetype;
      }
    } catch (error) {
      if (error instanceof BusinessException) throw error;
      throw invalid('头像上传格式无效：仅允许一个 file 图片且不得超过 2 MiB');
    }
    if (!bytes) throw invalid('缺少 file 图片');
    const normalized = await normalizeAgentAvatar(bytes, mime);
    const file = await fileService.uploadFile(normalized, 'agent-avatar.png', 'image/png', userId, null);
    // 2026-11-24 D7：新上传在 {uploadDir}/{userId}/ 下，URL 必须带用户 id 段；
    // 旧正则只认一段路径，不放宽就存不上。按 filePath 相对上传根拼（与 toVO 同口径）。
    const result: AgentAvatarUploadVO = { avatarUrl: avatarUploadUrl(file, fileService.getUploadDir()) };
    return sendOk(reply, result);
  });
}
