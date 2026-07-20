import OSS from 'ali-oss'

export interface StsToken {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  bucket: string
  region: string
  uploadDir: string
  expiration: string
}

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
}

function hasImageExtension(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name)
}

function extensionForMime(mime: string): string {
  return IMAGE_EXT_BY_MIME[mime] || '.jpg'
}

async function detectImageMime(file: File): Promise<string | null> {
  const buf = await file.slice(0, 12).arrayBuffer()
  const bytes = new Uint8Array(buf)
  // Need 12 bytes for WebP; PNG also reads index 3. Match backend ImageFileSupport.
  if (bytes.length < 12) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif'
  }
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/** Ensure image File has a usable MIME and filename extension before OSS upload. */
export async function normalizeImageForUpload(file: File): Promise<File> {
  let mime = file.type
  if (!mime || mime === 'application/octet-stream' || !mime.startsWith('image/')) {
    mime = (await detectImageMime(file)) || 'image/jpeg'
  }

  let name = (file.name && file.name.trim()) || 'image'
  if (!hasImageExtension(name)) {
    name = `${name}${extensionForMime(mime)}`
  }

  if (mime === file.type && name === file.name) {
    return file
  }
  return new File([file], name, { type: mime })
}

export async function uploadToOss(file: File, stsToken: StsToken): Promise<string> {
  const client = new OSS({
    region: stsToken.region,
    accessKeyId: stsToken.accessKeyId,
    accessKeySecret: stsToken.accessKeySecret,
    stsToken: stsToken.securityToken,
    bucket: stsToken.bucket,
  })

  const normalized = await normalizeImageForUpload(file)
  const key = `${stsToken.uploadDir}${Date.now()}_${normalized.name}`
  const result = await client.put(key, normalized, {
    mime: normalized.type || 'image/jpeg',
  })
  return result.url
}
