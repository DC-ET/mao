import type { UploadTicketVO } from '@mao/contracts'

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

/** Ensure image File has a usable MIME and filename extension before direct upload. */
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

/**
 * 预签名 PUT 直传对象存储（oss/cos/obs 统一链路，前端不感知具体云厂商）。
 * XHR 而非 fetch：保留上传进度能力（进度 UI 尚未接入，接口留好）。
 * OBS 模式 Content-Type 参与签名，必须与签发票据时的值完全一致。
 */
export function uploadViaTicket(file: File, ticket: UploadTicketVO): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', ticket.uploadUrl, true)
    xhr.setRequestHeader('Content-Type', file.type || 'image/jpeg')
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(ticket.publicUrl)
      } else {
        reject(new Error(`直传被拒绝 (HTTP ${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('直传网络错误（请检查 bucket CORS 配置）'))
    xhr.ontimeout = () => reject(new Error('直传超时'))
    xhr.send(file)
  })
}
