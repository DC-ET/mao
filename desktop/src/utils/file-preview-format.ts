/**
 * 工作区文件预览格式判定（技术方案 §5.1）：扩展名先行 + 内容 sniff 兜底。
 *
 * 只判定「新增预览格式」。markdown / PDF / 图片 / 文本 / 二进制五条既有路径
 * 不在此函数内：PDF 由 FileViewer 的 isPdfPath 判定、图片由后端 readFile 的
 * media_type 判定、文本与二进制由 readFile 结果判定——保持既有链路一行不动。
 * 图片集合以后端 ImageFileSupport.mimeFromPath 为准（.png/.jpg/.jpeg/.gif/.webp），
 * 本函数不重复判定图片，避免两端集合漂移。
 */

import { MEDIA_EXTENSIONS } from './media-format'

/** 新增预览格式（技术方案 §5.1）：字节类四个 + 文本类一个。 */
export type NewPreviewKind = 'csv' | 'xlsx' | 'docx' | 'zip' | 'media'

const CSV_EXTENSIONS = ['csv', 'tsv', 'tab']
const XLSX_EXTENSIONS = ['xlsx', 'xlsm', 'xltx']
const DOCX_EXTENSIONS = ['docx']
const ZIP_EXTENSIONS = ['zip']

function extOf(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  // 无扩展名或点文件（.gitignore）返回空
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * 扩展名判定。返回 null = 交回既有 readFile 文本路径（现状）。
 * 注意顺序对结果无影响（扩展名互斥），xlsx / docx 先于 zip 的判定顺序
 * 只在 sniff 兜底路径需要（见 sniffContainerKind）。
 */
export function resolvePreviewKind(filePath: string): NewPreviewKind | null {
  const ext = extOf(filePath)
  if (ext === '') return null
  if (CSV_EXTENSIONS.includes(ext)) return 'csv'
  if (XLSX_EXTENSIONS.includes(ext)) return 'xlsx'
  if (DOCX_EXTENSIONS.includes(ext)) return 'docx'
  if (ZIP_EXTENSIONS.includes(ext)) return 'zip'
  if (MEDIA_EXTENSIONS.includes(ext)) return 'media'
  return null
}

/** zip 家族本地文件头魔数：普通条目 PK\x03\x04 / 空档 PK\x05\x06 / 跨卷 PK\x07\x08。 */
const ZIP_MAGICS = ['PK\u0003\u0004', 'PK\u0005\u0006', 'PK\u0007\u0008']

/**
 * readFile 文本内容 sniff 兜底（技术方案 §5.1 / §6-B7）：仅 LOCAL 可达
 * （CLOUD 的 readFile 遇 NUL 字节直接抛「二进制文件，无法预览」，
 * 见 backend-ts/src/file/workspace-browse.service.ts）。
 * 用于无扩展名 / 扩展名撒谎的文件；xlsx 用 'xl/workbook.xml' 特征串区分，
 * 内容窗口（512KB）内的小 xlsx 可靠，超大 xlsx 可能漏判为 zip——
 * 兜底路径的最佳努力，不承诺全覆盖（评审记录在案的不对称）。
 *
 * 调用方必须把本函数排在「二进制内容（含 NUL）判 binary」之前：真实 zip 的本地
 * 文件头第 5 字节（version needed to extract）必为 0x00，先做 NUL 检查会让所有
 * 真实压缩包都进 binary 态，兜底永不生效（review round1 #1）。
 */
export function sniffContainerKind(content: string): 'zip' | 'xlsx' | null {
  if (content.length < 4) return null
  if (!ZIP_MAGICS.some((magic) => content.startsWith(magic))) return null
  return content.includes('xl/workbook.xml') ? 'xlsx' : 'zip'
}
