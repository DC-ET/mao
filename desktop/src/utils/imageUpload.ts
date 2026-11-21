import { ElMessage } from 'element-plus'
import { api } from '../api'
import { normalizeImageForUpload, uploadViaTicket } from './objectStorageUpload'
import { getUploadConfig, type UploadConfig } from './storageMode'

/**
 * Upload chat image attachments (local API or object-storage direct upload) and return accessible URLs.
 * @param sessionId optional session for scoping upload credentials / local files
 */
export async function uploadImages(files: File[], sessionId?: string | null): Promise<string[]> {
  if (files.length === 0) return []

  const config: UploadConfig = await getUploadConfig()

  if (config.storageMode === 'local') {
    const urls: string[] = []
    for (const file of files) {
      try {
        const normalized = await normalizeImageForUpload(file)
        const formData = new FormData()
        formData.append('file', normalized)
        if (sessionId) {
          formData.append('sessionId', String(sessionId))
        }
        const { data } = await api.post('/files/upload', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        })
        urls.push(data.url)
      } catch {
        ElMessage.error(`图片 ${file.name} 上传失败`)
      }
    }
    return urls
  }

  // 对象存储直传（oss / cos / obs 统一预签名票据链路，前端不感知具体云厂商）
  const urls: string[] = []
  for (const file of files) {
    try {
      const normalized = await normalizeImageForUpload(file)
      const { data } = await api.post('/upload/ticket', {
        contentType: normalized.type || 'image/jpeg',
        fileName: normalized.name,
      })
      urls.push(await uploadViaTicket(normalized, data))
    } catch (error) {
      if ((error as Error & { toastShown?: boolean }).toastShown) continue
      ElMessage.error(`图片 ${file.name} 上传失败`)
    }
  }
  return urls
}
