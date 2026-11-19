import type { RawArchiveEntry } from './archive-entries'

/** Gzip 流式解压安全上限（对齐后端 64MB 单文件预览上限，防 gzip 炸弹撑爆渲染进程内存）。 */
export const TAR_GZIP_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024

const UTF8_DECODER = new TextDecoder('utf-8')

export interface ParsedTarEntry extends RawArchiveEntry {
  /** 指向解压后 tar 缓冲区的零拷贝切片（目录条目为空切片） */
  data: Uint8Array
}

export function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

export function isTarFileName(fileName: string): boolean {
  const lower = (fileName || '').trim().toLowerCase()
  return lower.endsWith('.tar') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz')
}

export function hasUstarMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 263) return false
  // POSIX ustar: offset 257..262 === "ustar"
  return (
    bytes[257] === 0x75
    && bytes[258] === 0x73
    && bytes[259] === 0x74
    && bytes[260] === 0x61
    && bytes[261] === 0x72
  )
}

/** 使用标准 DecompressionStream('gzip') 流式解压并实施字节上限守卫。 */
export async function gunzipBounded(
  compressed: Uint8Array,
  maxBytes = TAR_GZIP_MAX_UNCOMPRESSED_BYTES,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前环境不支持 GZIP 解压预览，请下载后查看')
  }
  const ds = new DecompressionStream('gzip')
  const writer = ds.writable.getWriter()
  const payload = compressed.byteOffset === 0 && compressed.byteLength === compressed.buffer.byteLength
    ? compressed
    : compressed.slice()
  const writeTask = writer
    .write(payload as unknown as BufferSource)
    .then(() => writer.close())
    .catch(() => {})

  const reader = ds.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`解压后体积超过 ${Math.round(maxBytes / (1024 * 1024))} MB 预览上限，请下载后查看`)
      }
      chunks.push(value)
    }
  } finally {
    await writeTask
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function readCString(buf: Uint8Array, start: number, length: number): string {
  let end = start
  const limit = Math.min(buf.byteLength, start + length)
  while (end < limit && buf[end] !== 0) end++
  return UTF8_DECODER.decode(buf.subarray(start, end))
}

function parseTarSize(buf: Uint8Array, start: number, length: number): number {
  const first = buf[start]
  // GNU base-256 大文件扩展（最高位为 1）
  if ((first & 0x80) !== 0) {
    let value = 0
    for (let i = start + 1; i < start + length; i++) {
      value = value * 256 + buf[i]
    }
    return value
  }
  const raw = readCString(buf, start, length).trim()
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 8)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('TAR 归档头大小字段非法')
  }
  return parsed
}

function isZeroBlock(buf: Uint8Array, offset: number): boolean {
  const end = Math.min(buf.byteLength, offset + 512)
  for (let i = offset; i < end; i++) {
    if (buf[i] !== 0) return false
  }
  return true
}

/** 解析 PAX 扩展头（`<byteLen> <key>=<value>\n`）中的 path / size。 */
function parsePaxRecords(payload: Uint8Array): { path?: string; size?: number } {
  const out: { path?: string; size?: number } = {}
  let pos = 0
  while (pos < payload.byteLength) {
    let spaceIdx = pos
    while (spaceIdx < payload.byteLength && payload[spaceIdx] !== 0x20) spaceIdx++
    if (spaceIdx >= payload.byteLength) break
    const lenStr = UTF8_DECODER.decode(payload.subarray(pos, spaceIdx))
    const recLen = Number.parseInt(lenStr, 10)
    if (!Number.isFinite(recLen) || recLen <= spaceIdx - pos + 1 || pos + recLen > payload.byteLength) {
      break
    }
    let recEnd = pos + recLen
    if (payload[recEnd - 1] === 0x0a) recEnd--
    const kv = UTF8_DECODER.decode(payload.subarray(spaceIdx + 1, recEnd))
    const eq = kv.indexOf('=')
    if (eq > 0) {
      const key = kv.slice(0, eq)
      const val = kv.slice(eq + 1)
      if (key === 'path') out.path = val
      else if (key === 'size') {
        const n = Number.parseInt(val, 10)
        if (Number.isFinite(n) && n >= 0) out.size = n
      }
    }
    pos += recLen
  }
  return out
}

function normalizeEntryName(rawName: string, isDirectory: boolean): string {
  const cleaned = rawName.replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (!cleaned) return ''
  if (isDirectory && !cleaned.endsWith('/')) return `${cleaned}/`
  return cleaned
}

/**
 * 解析未压缩的 POSIX ustar / PAX / GNU TAR 字节流。
 */
export function parseTarBytes(tarBytes: Uint8Array, compressedRatio = 1): ParsedTarEntry[] {
  if (tarBytes.byteLength === 0) return []
  if (tarBytes.byteLength < 512) {
    throw new Error('TAR 归档内容不完整或已损坏')
  }

  const entries: ParsedTarEntry[] = []
  let offset = 0
  let pendingPax: { path?: string; size?: number } = {}
  let pendingGnuName: string | null = null

  while (offset + 512 <= tarBytes.byteLength) {
    if (isZeroBlock(tarBytes, offset)) {
      break
    }

    const nameField = readCString(tarBytes, offset, 100)
    const sizeField = parseTarSize(tarBytes, offset + 124, 12)
    const typeFlagByte = tarBytes[offset + 156]
    const typeFlag = typeFlagByte === 0 ? '0' : String.fromCharCode(typeFlagByte)
    const ustar = hasUstarMagic(tarBytes.subarray(offset, offset + 512))
    const prefix = ustar ? readCString(tarBytes, offset + 345, 155) : ''

    const size = pendingPax.size ?? sizeField
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tarBytes.byteLength) {
      throw new Error('TAR 归档内容截断或已损坏')
    }
    const paddedDataBytes = Math.ceil(size / 512) * 512
    const nextOffset = dataStart + paddedDataBytes

    // PAX 局部扩展头：作用于下一条真实记录
    if (typeFlag === 'x') {
      pendingPax = { ...pendingPax, ...parsePaxRecords(tarBytes.subarray(dataStart, dataEnd)) }
      offset = nextOffset
      continue
    }
    // PAX 全局头或 GNU 长链接目标名：跳过自身
    if (typeFlag === 'g' || typeFlag === 'K') {
      offset = nextOffset
      continue
    }
    // GNU LongLink 长文件名：作用于下一条真实记录
    if (typeFlag === 'L') {
      pendingGnuName = readCString(tarBytes, dataStart, size)
      offset = nextOffset
      continue
    }

    const joinedUstarName = prefix ? (nameField ? `${prefix}/${nameField}` : prefix) : nameField
    const rawName = pendingPax.path ?? pendingGnuName ?? joinedUstarName
    pendingPax = {}
    pendingGnuName = null

    const isDirectory = typeFlag === '5' || rawName.endsWith('/')
    const isRegularFile = typeFlag === '0' || typeFlag === '7'
    // 跳过符号链接/硬链接/FIFO/设备节点，仅展示目录与普通文件
    if (!isDirectory && !isRegularFile) {
      offset = nextOffset
      continue
    }

    const normalizedName = normalizeEntryName(rawName, isDirectory)
    if (normalizedName) {
      entries.push({
        name: normalizedName,
        isDirectory,
        uncompressedSize: isDirectory ? 0 : size,
        compressedSize: isDirectory ? 0 : Math.round(size * compressedRatio),
        data: isDirectory ? new Uint8Array(0) : tarBytes.subarray(dataStart, dataEnd),
      })
    }

    offset = nextOffset
  }

  return entries
}

/**
 * 加载 `.tar` / `.tar.gz` / `.tgz` 字节流并返回条目列表。
 */
export async function loadTarArchive(bytes: Uint8Array): Promise<ParsedTarEntry[]> {
  if (isGzipBytes(bytes)) {
    const uncompressed = await gunzipBounded(bytes)
    const ratio = uncompressed.byteLength > 0 ? Math.min(1, bytes.byteLength / uncompressed.byteLength) : 1
    return parseTarBytes(uncompressed, ratio)
  }
  return parseTarBytes(bytes, 1)
}
