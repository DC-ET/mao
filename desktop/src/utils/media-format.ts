/**
 * 媒体预览格式判定与阈值（技术方案 §5.7 / 决策 5）：扩展名 → video / audio
 * 元素分支 + Blob MIME + 50MB 播放上限（超限降级下载，阈值集中为常量）。
 * 纯函数，node 环境可单测。白名单以这里为唯一来源——file-preview-format 的
 * dispatch 判定直接 import 本常量，避免「进得了 MediaPlayer 却不认扩展名」的漂移。
 */

/** 播放上限（决策 5）：超过不播放，工具栏提示并转下载 / Finder 显示 */
export const MEDIA_MAX_BYTES = 50 * 1024 * 1024

type MediaKind = 'video' | 'audio'

/** video 元素分支（其余白名单扩展名走 audio） */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov']
/** audio 元素分支 */
const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'flac', 'ogg']

/** 媒体预览扩展名白名单（dispatch 与 MIME / 元素分支共用的唯一来源） */
export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]

const MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
}

function extOf(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/** 扩展名 → video / audio；白名单外（含无扩展名）回落 video（video 元素也能播纯音频） */
export function mediaKindOf(filePath: string): MediaKind {
  const ext = extOf(filePath)
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio'
  return 'video'
}

/** 扩展名 → Blob MIME；未知扩展名回落通用的 application/octet-stream */
export function mediaMimeOf(filePath: string): string {
  return MIME_BY_EXTENSION[extOf(filePath)] ?? 'application/octet-stream'
}

/**
 * 是否依赖专有编解码（技术方案 §6-G2 ★）：Electron 官方构建不含 H.264 / AAC，
 * 这两个容器可能黑屏或直接播放失败，需要常驻标注 + 失败时可下载。
 * 白名单已优先 webm / ogg / wav，故只有这两个容器需要提示。
 */
export function isCodecDependent(filePath: string): boolean {
  const ext = extOf(filePath)
  return ext === 'mp4' || ext === 'mov'
}
