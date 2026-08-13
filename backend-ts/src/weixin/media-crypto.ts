import { decryptAes128Ecb } from '../crypto/aes-gcm.js';

export function decryptWeixinAes128Ecb(ciphertext: Buffer, key: Buffer): Buffer {
  return decryptAes128Ecb(ciphertext, key);
}

export function resolveMediaNode(fileItem: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (fileItem == null) return null;
  for (const mediaField of ['media', 'thumb_media']) {
    const media = fileItem[mediaField] as Record<string, unknown> | undefined;
    if (media != null) {
      const param = textOrNull(media.encrypt_query_param);
      if (param != null && param.trim() !== '') return media;
    }
  }
  return null;
}

export function resolveEncryptQueryParam(fileItem: Record<string, unknown> | null | undefined): string | null {
  const media = resolveMediaNode(fileItem);
  if (media != null) return textOrNull(media.encrypt_query_param);
  return textOrNull(fileItem != null ? fileItem.encrypt_query_param : null);
}

export function detectFileMime(bytes: Buffer | Uint8Array | null | undefined, fileName: string | null | undefined): string {
  if (bytes != null && bytes.length >= 4
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf';
  }
  const lower = fileName != null ? fileName.toLowerCase() : '';
  const dot = lower.lastIndexOf('.');
  if (dot >= 0 && dot < lower.length - 1) {
    switch (lower.slice(dot + 1)) {
      case 'pdf': return 'application/pdf';
      case 'txt':
      case 'md':
      case 'markdown': return 'text/plain';
      case 'doc': return 'application/msword';
      case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'xls': return 'application/vnd.ms-excel';
      case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      case 'ppt': return 'application/vnd.ms-powerpoint';
      case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      case 'png': return 'image/png';
      case 'jpg':
      case 'jpeg': return 'image/jpeg';
      case 'gif': return 'image/gif';
      case 'webp': return 'image/webp';
      case 'zip': return 'application/zip';
      case 'json': return 'application/json';
      case 'csv': return 'text/csv';
      default: return 'application/octet-stream';
    }
  }
  return 'application/octet-stream';
}

export function resolveAesKey(
  imageItem: Record<string, unknown> | null | undefined,
  media: Record<string, unknown> | null | undefined,
): Buffer | null {
  const imageAesKey = textOrNull(imageItem != null ? imageItem.aeskey : null);
  if (imageAesKey != null && imageAesKey.trim() !== '') {
    const fromHex = tryHexDecode(imageAesKey.trim());
    if (fromHex != null && fromHex.length === 16) return fromHex;
    const fromBase64 = decodeAesKey(imageAesKey.trim());
    if (fromBase64 != null) return fromBase64;
  }
  const itemAesKey = textOrNull(imageItem != null ? imageItem.aes_key : null);
  if (itemAesKey != null && itemAesKey.trim() !== '') {
    const decoded = decodeAesKey(itemAesKey.trim());
    if (decoded != null) return decoded;
  }
  const mediaAesKey = textOrNull(media != null ? media.aes_key : null);
  if (mediaAesKey != null && mediaAesKey.trim() !== '') {
    return decodeAesKey(mediaAesKey.trim());
  }
  return null;
}

export function decodeAesKey(raw: string | null | undefined): Buffer | null {
  if (raw == null || raw.trim() === '') return null;
  const trimmed = raw.trim();
  const directHex = tryHexDecode(trimmed);
  if (directHex != null && directHex.length === 16) return directHex;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const asAscii = decoded.toString('ascii');
    const hexDecoded = tryHexDecode(asAscii);
    if (hexDecoded != null && hexDecoded.length === 16) return hexDecoded;
  }
  return null;
}

export function tryHexDecode(hex: string | null): Buffer | null {
  if (hex == null) return null;
  const s = hex.trim();
  if (s.length % 2 !== 0) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
    if (!ok) return null;
  }
  return Buffer.from(s, 'hex');
}

export function textOrNull(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

export function extensionForMime(mime: string | null): string {
  if (mime == null) return '.jpg';
  switch (mime.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/gif': return '.gif';
    case 'image/webp': return '.webp';
    default: return '.jpg';
  }
}
