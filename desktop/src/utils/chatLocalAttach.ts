import { ElMessage } from 'element-plus'
import { getUploadConfig } from './storageMode'

/** LOCAL 暂存的非图片文件：File 对象 + 主进程可读的绝对路径（Electron 拖拽/选择时取得）。 */
export interface LocalPendingFile {
  file: File
  /** 源文件在本机的绝对路径；空串表示取不到本机源文件（文本走内容内联写入，其余无法拷贝） */
  localPath: string
}

export interface LocalPendingFilesCopyResult {
  /** 拼接了 @{absolutePath}@ 文件引用的消息文本 */
  text: string
  /** 拷贝成功的文件数；与入参 files.length 对比可判断全部/部分失败 */
  copiedCount: number
}

/**
 * 批量拷贝非图片文件到本机 `~/.mao/attachments/<host>/<sessionId>/`（LOCAL 模式），
 * 返回拼接了 @{absolutePath}@ 引用的文本。与 CLOUD 的 uploadPendingFiles 同时机
 * （发送时、ensureSession 之后）、同结构，只是落点从服务端 runtime incoming 变成本机目录。
 *
 * 单文件失败只提示不阻断其余；全部失败时返回原文本与 copiedCount=0，
 * 由调用方（guardUploadsBeforeSend）决定是否阻断发送。
 *
 * @param text 原始消息文本
 * @param files 待拷贝的非图片文件列表
 * @param sessionId 目标会话 ID（此时会话已落库）
 */
export async function copyLocalPendingFiles(
  text: string,
  files: LocalPendingFile[],
  sessionId: string
): Promise<LocalPendingFilesCopyResult> {
  const api = (window as any).electronAPI
  const maxSizeMb = await resolveMaxSizeMb()
  const refs: string[] = []
  for (const item of files) {
    if (!api?.localCopyAttachment) {
      ElMessage.error(`文件 ${item.file.name} 加入失败：当前客户端不支持本地附件`)
      continue
    }
    if (!item.localPath) {
      // 无本机源路径的文本文件（输入框粘贴超长文本转出的内存 File）：发送时把内容交给
      // 主进程写进会话附件目录，拿到路径后与普通附件同形态引用；写不了再沿用原有报错。
      const inline = await writeInlineTextAttachment(api, item.file, sessionId, maxSizeMb)
      if (inline == null) {
        ElMessage.error(`文件 ${item.file.name} 加入失败：无法获取文件路径`)
      } else if (inline.ok) {
        refs.push(`@{${inline.absolutePath}}@`)
      } else {
        ElMessage.error(`文件 ${item.file.name} ${inline.error || '写入失败'}`)
      }
      continue
    }
    try {
      const result = await api.localCopyAttachment({
        sourcePath: item.localPath,
        sessionId: Number(sessionId),
        maxSizeMb,
      })
      if (result?.ok && result.absolutePath) {
        refs.push(`@{${result.absolutePath}}@`)
      } else {
        ElMessage.error(`文件 ${item.file.name} ${result?.error || '拷贝失败'}`)
      }
    } catch {
      ElMessage.error(`文件 ${item.file.name} 拷贝失败`)
    }
  }
  if (refs.length === 0) return { text, copiedCount: 0 }
  return { text: text ? `${text}\n${refs.join(' ')}` : refs.join(' '), copiedCount: refs.length }
}

/**
 * 「只有内存内容、没有本机源文件」的文本附件落盘（输入框粘贴超长文本转出的
 * `pasted-text-N.txt`）：主进程写到 `~/.mao/attachments/<host>/<sid>/`，返回本机
 * 绝对路径。非文本文件、或客户端没有对应桥（旧版桌面端）时返回 null，
 * 由调用方沿用「无法获取文件路径」的既有报错。
 */
async function writeInlineTextAttachment(
  api: any,
  file: File,
  sessionId: string,
  maxSizeMb: number | undefined
): Promise<{ ok: true; absolutePath: string } | { ok: false; error?: string } | null> {
  const writeTextFile = api?.localWriteTextFile
  if (typeof writeTextFile !== 'function') return null
  if (!file.type.startsWith('text/')) return null
  try {
    const content = await file.text()
    const result = await writeTextFile({
      fileName: file.name,
      content,
      sessionId: Number(sessionId),
      maxSizeMb,
    })
    if (result?.ok && result.absolutePath) return { ok: true, absolutePath: result.absolutePath }
    return { ok: false, error: result?.error }
  } catch {
    return { ok: false, error: '写入失败' }
  }
}

/** 与 CLOUD 同口径的大小上限（后端上传配置）；取不到时传 undefined，由主进程回落默认值。 */
async function resolveMaxSizeMb(): Promise<number | undefined> {
  try {
    const { maxSizeMb } = await getUploadConfig()
    return Number.isFinite(maxSizeMb) && maxSizeMb > 0 ? maxSizeMb : undefined
  } catch {
    return undefined
  }
}
