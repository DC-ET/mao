import { ElMessage } from 'element-plus'
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

/**
 * 批量上传非图片文件到 runtime incoming，返回拼接了 @{absPath}@ 引用的文本。
 * @param text 原始消息文本
 * @param files 待上传的非图片文件列表
 * @param sessionId 目标会话 ID
 * @returns 拼接了文件引用的消息文本
 */
export async function uploadPendingFiles(text: string, files: File[], sessionId: string): Promise<string> {
  const refs: string[] = []
  for (const file of files) {
    const uploaded = await uploadChatFile(file, sessionId)
    if (uploaded?.absolutePath) {
      refs.push(`@{${uploaded.absolutePath}}@`)
    } else {
      ElMessage.error(`文件 ${file.name} 上传失败`)
    }
  }
  if (refs.length === 0) return text
  return text ? `${text}\n${refs.join(' ')}` : refs.join(' ')
}