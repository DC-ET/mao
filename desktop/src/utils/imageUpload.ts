import { ElMessage } from 'element-plus'
import { api } from '../api'
import { normalizeImageForUpload, uploadToOss, type StsToken } from './ossUpload'
import { getUploadConfig, type UploadConfig } from './storageMode'

/**
 * Upload chat image attachments (local API or OSS) and return accessible URLs.
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

  let stsToken: StsToken
  try {
    const { data } = await api.post('/oss/sts-token', {
      sessionId: sessionId ? Number(sessionId) : null
    })
    stsToken = data
  } catch (error) {
    // 具体原因（连接超时 / OSS 未配置 / STS 鉴权失败）已由响应拦截器提示；
    // 只有拦截器没有提示时才兜底，避免再弹一条通用文案把真实原因冲掉
    if (!(error as Error & { toastShown?: boolean }).toastShown) {
      ElMessage.error('获取上传凭证失败，请稍后重试')
    }
    return []
  }

  const urls: string[] = []
  for (const file of files) {
    try {
      const url = await uploadToOss(file, stsToken)
      urls.push(url)
    } catch {
      ElMessage.error(`图片 ${file.name} 上传失败`)
    }
  }
  return urls
}
