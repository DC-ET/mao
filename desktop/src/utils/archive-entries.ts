/**
 * ZIP 中央目录评估与条目分类（技术方案 §5.4）：zip 炸弹三道防线 + 条目点击
 * 行为分类。纯函数、零依赖，node 环境全测；JSZip 动态加载与渲染在
 * ArchiveBrowser.vue，本模块只碰从中央目录抽出的原始条目数据。
 */

/** 条目数上限：对齐后端 MAX_ENTRIES（workspace 目录列举同口径）。 */
export const ZIP_MAX_ENTRIES = 500
/** 中央目录解压大小合计上限（懒解压是前提，这里只信中央目录声明值）。 */
export const ZIP_MAX_TOTAL_BYTES = 500 * 1024 * 1024
/** 单条目解压大小上限：超限条目置灰不可预览，仅整包下载。 */
export const ZIP_MAX_ENTRY_BYTES = 100 * 1024 * 1024
/** 文本条目内存预览上限：超过走下载，避免把超大文本灌进 <pre> 冻死渲染进程。 */
export const ZIP_TEXT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export interface RawArchiveEntry {
  name: string
  isDirectory: boolean
  /** 中央目录声明的解压后大小 */
  uncompressedSize: number
  /** 中央目录声明的压缩后大小 */
  compressedSize: number
}

export interface ArchiveEntry {
  name: string
  /** 末段文件名（展示用；全名在 title） */
  displayName: string
  isDirectory: boolean
  uncompressedSize: number
  compressedSize: number
  /** 单条目超 ZIP_MAX_ENTRY_BYTES：置灰不可预览 */
  tooLarge: boolean
}

export interface ArchiveEvaluation {
  /** 按名称排序的扁平条目（目录与文件混排，目录名前缀天然聚成树观感） */
  entries: ArchiveEntry[]
  /** 超限拒绝原因（条目数 / 总大小任一）：非空即整个压缩包不进入浏览 */
  rejected?: string
  hasTooLargeEntries: boolean
}

/**
 * zip 炸弹三道防线（技术方案 §5.4）：
 * 1. 文件条目数 > ZIP_MAX_ENTRIES → 整包拒绝；
 * 2. 解压大小合计 > ZIP_MAX_TOTAL_BYTES → 整包拒绝；
 * 3. 单条目 > ZIP_MAX_ENTRY_BYTES → 该条目标灰（evaluateArchive 内置 tooLarge）。
 */
export function evaluateArchive(raw: RawArchiveEntry[]): ArchiveEvaluation {
  const files = raw.filter((e) => !e.isDirectory)

  let rejected: string | undefined
  if (files.length > ZIP_MAX_ENTRIES) {
    rejected = `条目过多（${files.length} 个），超过 ${ZIP_MAX_ENTRIES} 个上限，请下载后查看`
  } else {
    const totalUncompressed = files.reduce((sum, f) => sum + f.uncompressedSize, 0)
    if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
      rejected = `解压后总大小约 ${(totalUncompressed / (1024 * 1024)).toFixed(0)} MB，超过 ${ZIP_MAX_TOTAL_BYTES / (1024 * 1024)} MB 上限，请下载后查看`
    }
  }

  const entries: ArchiveEntry[] = raw
    .map((e) => ({
      name: e.name,
      displayName: displayNameOf(e.name, e.isDirectory),
      isDirectory: e.isDirectory,
      uncompressedSize: e.uncompressedSize,
      compressedSize: e.compressedSize,
      tooLarge: !e.isDirectory && e.uncompressedSize > ZIP_MAX_ENTRY_BYTES,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    entries,
    rejected,
    hasTooLargeEntries: entries.some((e) => e.tooLarge),
  }
}

/** 末段名：目录条目剥掉末尾斜杠再取末段（`docs/readme/` → `readme/` 观感由 isDirectory 图标承担）。 */
export function displayNameOf(name: string, isDirectory: boolean): string {
  const base = name.replace(/[/\\]+$/, '')
  const seg = base.split(/[/\\]/).pop() ?? base
  return isDirectory ? `${seg}/` : seg
}

/** 条目点击分类：图片内嵌预览 / PDF 走 PdfViewer / 文本内存 <pre> / 其他下载。 */
export type ArchiveEntryKind = 'image' | 'pdf' | 'text' | 'other'

/** 与 file-manager.ts / FileTreeNode.vue 的图片图标集合一致（前端既有口径）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

/** 常见文本 / 代码格式：命中进内存 <pre> 预览，未命中一律下载（不猜）。 */
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'tab', 'log', 'json', 'json5', 'jsonc',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'sh', 'bash', 'zsh', 'fish', 'sql', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue',
  'py', 'rb', 'php', 'java', 'kt', 'kts', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'swift', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'svelte',
  'gradle', 'dockerfile', 'makefile', 'gitignore', 'gitattributes', 'editorconfig',
  'rst', 'tex', 'adoc', 'bat', 'ps1',
])

export function classifyArchiveEntry(name: string): ArchiveEntryKind {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'pdf') return 'pdf'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'other'
}

/** 压缩率展示：省空间百分比；空文件 / 无压缩收益返回 '—'。 */
export function compressionRatio(compressedSize: number, uncompressedSize: number): string {
  if (uncompressedSize <= 0) return '—'
  const ratio = 1 - compressedSize / uncompressedSize
  if (ratio <= 0) return '—'
  return `${Math.round(ratio * 100)}%`
}
