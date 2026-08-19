import { api } from '../api'

export interface UploadedChatFile {
  id?: number
  originalName: string
  fileSize: number
  mimeType?: string | null
  sessionId?: number | null
  url: string
  /** 服务端 runtime 临时目录内的绝对路径，作为文件引用（@{absolutePath}@）写入消息。 */
  absolutePath: string
}

/**
 * 上传任意文件到会话 runtime incoming 目录（CLOUD 模式）。
 * @param file 用户选择的文件（非图片）
 * @param sessionId 目标会话 ID
 * @returns 上传结果；失败返回 null（内部已提示）
 */
export async function uploadChatFile(file: File, sessionId: string): Promise<UploadedChatFile | null> {
  try {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('sessionId', String(sessionId))
    const { data } = await api.post<UploadedChatFile>('/files/upload-incoming', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return data
  } catch {
    return null
  }
}