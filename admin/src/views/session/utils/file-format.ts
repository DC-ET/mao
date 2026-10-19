/** 体积格式化：B/KB/MB/GB/TB，≥100 取整——规则对齐桌面端 utils/file-manager.ts */
export function formatSize(bytes?: number | null): string {
  if (bytes == null) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

/** mtimeMs（epoch ms）→ YYYY-MM-DD HH:mm（本地时区），对齐桌面端 */
export function formatTime(mtimeMs?: number | null): string {
  if (!mtimeMs) return '—'
  const d = new Date(mtimeMs)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 条目图标分类：符号链接 > 目录 > 图片 > 文档（规则对齐桌面端 utils/file-manager.ts 的 iconKindOf） */
export type FileIconKind = 'folder' | 'link' | 'image' | 'doc'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

export function iconKindOf(name: string, isDirectory: boolean, isSymlink?: boolean): FileIconKind {
  if (isSymlink) return 'link'
  if (isDirectory) return 'folder'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'doc'
}
