export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const ImageFileSupport = {
  MAX_IMAGE_BYTES,
  isImagePath(p: string | null | undefined): boolean {
    return this.mimeFromPath(p) != null;
  },

  mimeFromPath(p: string | null | undefined): string | undefined {
    if (p == null || p.trim() === '') return undefined;
    const lower = p.toLowerCase();
    for (const [ext, mime] of Object.entries(EXTENSION_TO_MIME)) {
      if (lower.endsWith(ext)) return mime;
    }
    return undefined;
  },

  isImageMime(mime: string | null | undefined): boolean {
    const n = this.normalizeMime(mime);
    return n != null && n.startsWith('image/');
  },

  detectMimeFromBytes(bytes: Uint8Array | Buffer | null | undefined): string | undefined {
    if (bytes == null || bytes.length < 12) return undefined;
    const b = bytes;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return 'image/webp';
    }
    return undefined;
  },

  resolveImageMime(bytes: Uint8Array | Buffer | null | undefined, declaredMime?: string | null, pathOrUrl?: string | null): string | undefined {
    const fromBytes = this.detectMimeFromBytes(bytes);
    if (fromBytes) return fromBytes;
    const declared = this.normalizeMime(declaredMime);
    if (declared?.startsWith('image/')) return declared;
    return this.mimeFromPath(pathOrUrl);
  },

  extensionForMime(mime: string | null | undefined): string | undefined {
    switch (this.normalizeMime(mime)) {
      case 'image/png': return '.png';
      case 'image/jpeg': return '.jpg';
      case 'image/gif': return '.gif';
      case 'image/webp': return '.webp';
      default: return undefined;
    }
  },

  normalizeMime(mime: string | null | undefined): string | undefined {
    if (mime == null || mime.trim() === '') return undefined;
    const normalized = mime.split(';', 2)[0].trim().toLowerCase();
    return normalized === '' ? undefined : normalized;
  },

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  },
};
