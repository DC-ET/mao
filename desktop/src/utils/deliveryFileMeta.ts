import type { SendDelivery } from '../types/chat'

export type DeliveryFileCategory =
  | 'archive'
  | 'pdf'
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'code'
  | 'media'
  | 'package'
  | 'generic'

export interface DeliveryFileMeta {
  category: DeliveryFileCategory
  /** 大写格式短标（如 "TAR.GZ" / "PDF" / "XLSX"，无后缀时为空串） */
  extBadge: string
  /** 面向用户的中文类型说明（如 "TAR.GZ 压缩包" / "PDF 文档" / "文件"） */
  typeLabel: string
}

const COMPOUND_EXTENSIONS: ReadonlyArray<{ suffix: string; badge: string; category: DeliveryFileCategory; noun: string }> = [
  { suffix: '.tar.gz', badge: 'TAR.GZ', category: 'archive', noun: '压缩包' },
  { suffix: '.tar.bz2', badge: 'TAR.BZ2', category: 'archive', noun: '压缩包' },
  { suffix: '.tar.xz', badge: 'TAR.XZ', category: 'archive', noun: '压缩包' },
  { suffix: '.tar.zst', badge: 'TAR.ZST', category: 'archive', noun: '压缩包' },
  { suffix: '.d.ts', badge: 'D.TS', category: 'code', noun: '代码' },
]

const SPECIAL_BASENAMES: Record<string, { category: DeliveryFileCategory; typeLabel: string }> = {
  dockerfile: { category: 'code', typeLabel: 'Docker 配置' },
  makefile: { category: 'code', typeLabel: 'Makefile 脚本' },
  '.env': { category: 'code', typeLabel: '环境配置' },
  '.gitignore': { category: 'code', typeLabel: 'Git 配置' },
  readme: { category: 'document', typeLabel: '说明文档' },
  license: { category: 'document', typeLabel: '许可文件' },
}

const ARCHIVE_EXTS = new Set([
  'zip', 'tar', 'gz', 'tgz', 'tbz', 'tbz2', 'txz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'aop',
])

const SPREADSHEET_EXTS = new Set([
  'xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods', 'numbers',
])

const WORD_DOC_EXTS = new Set([
  'doc', 'docx', 'odt', 'rtf', 'pages', 'wps',
])

const TEXT_DOC_EXTS = new Set([
  'txt', 'log', 'out',
])

const MARKDOWN_EXTS = new Set([
  'md', 'mdx', 'markdown',
])

const PRESENTATION_EXTS = new Set([
  'ppt', 'pptx', 'key', 'odp',
])

const DATA_CONFIG_EXTS = new Set([
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'xml', 'plist', 'properties', 'parquet',
])

const SCRIPT_EXTS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql',
])

const CODE_EXTS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx', 'vue', 'svelte',
  'py', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp',
  'cs', 'rb', 'php', 'swift', 'dart', 'lua', 'r', 'pl', 'ex', 'exs',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'graphql', 'gql', 'proto',
])

const AUDIO_EXTS = new Set([
  'mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'amr',
])

const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'flv', 'wmv', 'mpeg', 'mpg',
])

const PACKAGE_EXTS = new Set([
  'apk', 'ipa', 'dmg', 'pkg', 'exe', 'msi', 'deb', 'rpm', 'appimage',
])

function extractBasename(filename: string): string {
  const trimmed = (filename || '').trim()
  if (!trimmed) return ''
  const parts = trimmed.split(/[/\\]/)
  return parts[parts.length - 1] || trimmed
}

function classifyByExtension(ext: string): { category: DeliveryFileCategory; typeLabel: string } | null {
  const badge = ext.toUpperCase()
  if (ext === 'pdf') return { category: 'pdf', typeLabel: 'PDF 文档' }
  if (ARCHIVE_EXTS.has(ext)) return { category: 'archive', typeLabel: `${badge} 压缩包` }
  if (SPREADSHEET_EXTS.has(ext)) return { category: 'spreadsheet', typeLabel: `${badge} 表格` }
  if (MARKDOWN_EXTS.has(ext)) return { category: 'document', typeLabel: 'Markdown 文档' }
  if (WORD_DOC_EXTS.has(ext)) return { category: 'document', typeLabel: `${badge} 文档` }
  if (TEXT_DOC_EXTS.has(ext)) return { category: 'document', typeLabel: `${badge} 文本` }
  if (PRESENTATION_EXTS.has(ext)) return { category: 'presentation', typeLabel: `${badge} 演示文稿` }
  if (DATA_CONFIG_EXTS.has(ext)) return { category: 'code', typeLabel: `${badge} 数据` }
  if (SCRIPT_EXTS.has(ext)) return { category: 'code', typeLabel: `${badge} 脚本` }
  if (ext === 'diff' || ext === 'patch') return { category: 'code', typeLabel: `${badge} 补丁` }
  if (CODE_EXTS.has(ext)) return { category: 'code', typeLabel: `${badge} 代码` }
  if (AUDIO_EXTS.has(ext)) return { category: 'media', typeLabel: `${badge} 音频` }
  if (VIDEO_EXTS.has(ext)) return { category: 'media', typeLabel: `${badge} 视频` }
  if (PACKAGE_EXTS.has(ext)) return { category: 'package', typeLabel: `${badge} 安装包` }
  return null
}

function classifyByMime(mime?: string): DeliveryFileMeta {
  const m = (mime || '').trim().toLowerCase().split(';')[0]
  if (!m || m === 'application/octet-stream') {
    return { category: 'generic', extBadge: '', typeLabel: '文件' }
  }
  if (m === 'application/pdf') {
    return { category: 'pdf', extBadge: 'PDF', typeLabel: 'PDF 文档' }
  }
  if (
    m === 'application/zip'
    || m === 'application/gzip'
    || m === 'application/x-gzip'
    || m === 'application/x-tar'
    || m === 'application/x-bzip2'
    || m === 'application/x-xz'
    || m === 'application/x-7z-compressed'
    || m === 'application/vnd.rar'
    || m === 'application/x-rar-compressed'
  ) {
    return { category: 'archive', extBadge: '', typeLabel: '压缩包' }
  }
  if (
    m === 'text/csv'
    || m === 'text/tab-separated-values'
    || m.includes('spreadsheet')
    || m.includes('ms-excel')
  ) {
    return { category: 'spreadsheet', extBadge: '', typeLabel: '表格' }
  }
  if (m.includes('presentation') || m.includes('ms-powerpoint')) {
    return { category: 'presentation', extBadge: '', typeLabel: '演示文稿' }
  }
  if (m.includes('wordprocessing') || m === 'application/msword' || m === 'application/rtf') {
    return { category: 'document', extBadge: '', typeLabel: '文档' }
  }
  if (m === 'text/markdown') {
    return { category: 'document', extBadge: 'MD', typeLabel: 'Markdown 文档' }
  }
  if (m.startsWith('audio/')) {
    return { category: 'media', extBadge: '', typeLabel: '音频' }
  }
  if (m.startsWith('video/')) {
    return { category: 'media', extBadge: '', typeLabel: '视频' }
  }
  if (m === 'application/vnd.android.package-archive') {
    return { category: 'package', extBadge: 'APK', typeLabel: 'APK 安装包' }
  }
  if (
    m === 'application/json'
    || m === 'application/ld+json'
    || m === 'application/xml'
    || m === 'text/xml'
    || m === 'text/html'
    || m.includes('javascript')
    || m.startsWith('text/x-')
  ) {
    return { category: 'code', extBadge: '', typeLabel: '代码文件' }
  }
  if (m.startsWith('text/')) {
    return { category: 'document', extBadge: '', typeLabel: '文本文件' }
  }
  return { category: 'generic', extBadge: '', typeLabel: '文件' }
}

/**
 * 根据文件名与 MIME 推导投递文件卡片的图标分类与中文格式标签。
 * 优先识别复合后缀（如 `.tar.gz`），无扩展名或后端兜底 `.bin` 时回退到 MIME 判定。
 */
export function resolveDeliveryFileMeta(delivery: Pick<SendDelivery, 'filename' | 'mime'>): DeliveryFileMeta {
  const base = extractBasename(delivery.filename)
  const lower = base.toLowerCase()

  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(compound.suffix) && lower.length > compound.suffix.length) {
      return {
        category: compound.category,
        extBadge: compound.badge,
        typeLabel: `${compound.badge} ${compound.noun}`,
      }
    }
  }

  const special = SPECIAL_BASENAMES[lower]
  if (special) {
    return { category: special.category, extBadge: '', typeLabel: special.typeLabel }
  }

  const dot = lower.lastIndexOf('.')
  // dot > 0 排除以点开头的无扩展名隐藏文件（如 .bashrc）
  const ext = dot > 0 ? lower.slice(dot + 1) : ''

  if (!ext || ext === 'bin') {
    const byMime = classifyByMime(delivery.mime)
    if (byMime.category !== 'generic' || !ext) return byMime
    return { category: 'generic', extBadge: 'BIN', typeLabel: 'BIN 文件' }
  }

  const known = classifyByExtension(ext)
  if (known) {
    return {
      category: known.category,
      extBadge: ext.toUpperCase(),
      typeLabel: known.typeLabel,
    }
  }

  if (/^[a-z0-9]{1,8}$/.test(ext)) {
    const badge = ext.toUpperCase()
    return { category: 'generic', extBadge: badge, typeLabel: `${badge} 文件` }
  }

  return classifyByMime(delivery.mime)
}
