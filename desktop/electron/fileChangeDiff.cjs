'use strict'

// 文件变更 diff / 行统计 / 编辑匹配 / 写盘（自 main.cjs 抽出，技术方案 2026-11-19 §5.1）。
// 只依赖 fs、path，不依赖 Electron；渲染层 IPC 与 WS tool-execute 两条入口共用这里的实现，
// 审批与返回形状差异留在各自入口（§2.4，不在这里统一）。

const fs = require('fs')

const PRIVATE_DIFF_FIELD = 'file_change_diff'
const SNAPSHOT_LIMIT_BYTES = 512 * 1024
const PATCH_LIMIT_CHARS = 256 * 1024
const PATCH_CONTEXT_LINES = 3
const LCS_CELL_LIMIT = 2_000_000

function utf8Bytes(text) {
  return Buffer.byteLength(text || '', 'utf-8')
}

function isBinaryContent(text) {
  const value = text || ''
  const checkLen = Math.min(value.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (value.charCodeAt(i) === 0) return true
  }
  return false
}

function splitLines(text) {
  if (!text) return []
  return text.split(/\r\n|\r|\n/)
}

function lcsLength(oldLines, oldStart, oldEnd, newLines, newStart, newEnd) {
  const newLen = newEnd - newStart + 1
  let previous = new Array(newLen + 1).fill(0)
  let current = new Array(newLen + 1).fill(0)

  for (let i = oldStart; i <= oldEnd; i++) {
    for (let j = 1; j <= newLen; j++) {
      if (oldLines[i] === newLines[newStart + j - 1]) {
        current[j] = previous[j - 1] + 1
      } else {
        current[j] = Math.max(previous[j], current[j - 1])
      }
    }
    const temp = previous
    previous = current
    current = temp
    current.fill(0)
  }
  return previous[newLen]
}

function computeLineDelta(beforeContent, afterContent) {
  const oldLines = splitLines(beforeContent)
  const newLines = splitLines(afterContent)
  if (oldLines.length === 0) return { linesAdded: newLines.length, linesDeleted: 0 }
  if (newLines.length === 0) return { linesAdded: 0, linesDeleted: oldLines.length }

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let oldSuffix = oldLines.length - 1
  let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--
    newSuffix--
  }

  const oldChanged = oldSuffix - prefix + 1
  const newChanged = newSuffix - prefix + 1
  if (oldChanged <= 0) return { linesAdded: Math.max(0, newChanged), linesDeleted: 0 }
  if (newChanged <= 0) return { linesAdded: 0, linesDeleted: Math.max(0, oldChanged) }

  if (oldChanged * newChanged > LCS_CELL_LIMIT) {
    return { linesAdded: newChanged, linesDeleted: oldChanged }
  }

  const lcs = lcsLength(oldLines, prefix, oldSuffix, newLines, prefix, newSuffix)
  return { linesAdded: newChanged - lcs, linesDeleted: oldChanged - lcs }
}

function appendBounded(parts, state, text) {
  if (state.length >= PATCH_LIMIT_CHARS) {
    state.truncated = true
    return
  }
  const remaining = PATCH_LIMIT_CHARS - state.length
  if (text.length <= remaining) {
    parts.push(text)
    state.length += text.length
  } else {
    parts.push(text.slice(0, remaining))
    state.length += remaining
    state.truncated = true
  }
}

function buildUnifiedPatch(filePath, before, after) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let oldSuffix = oldLines.length - 1
  let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--
    newSuffix--
  }

  const contextStart = Math.max(0, prefix - PATCH_CONTEXT_LINES)
  const oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + PATCH_CONTEXT_LINES)
  const newContextEnd = Math.min(newLines.length - 1, newSuffix + PATCH_CONTEXT_LINES)
  const oldStartLine = contextStart + 1
  const newStartLine = contextStart + 1
  const oldCount = Math.max(0, oldContextEnd - contextStart + 1)
  const newCount = Math.max(0, newContextEnd - contextStart + 1)

  const parts = []
  const state = { length: 0, truncated: false }
  appendBounded(parts, state, `--- a/${filePath}\n`)
  appendBounded(parts, state, `+++ b/${filePath}\n`)
  appendBounded(parts, state, `@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@\n`)
  for (let i = contextStart; i < prefix && i < oldLines.length; i++) {
    appendBounded(parts, state, ` ${oldLines[i]}\n`)
  }
  for (let i = prefix; i <= oldSuffix && i < oldLines.length; i++) {
    appendBounded(parts, state, `-${oldLines[i]}\n`)
  }
  for (let i = prefix; i <= newSuffix && i < newLines.length; i++) {
    appendBounded(parts, state, `+${newLines[i]}\n`)
  }
  const sharedTailStart = Math.max(prefix, Math.max(oldSuffix + 1, newSuffix + 1))
  const sharedTailEnd = Math.min(oldContextEnd, oldLines.length - 1)
  for (let i = sharedTailStart; i <= sharedTailEnd; i++) {
    appendBounded(parts, state, ` ${oldLines[i]}\n`)
  }
  let content = parts.join('')
  if (state.truncated) {
    const suffix = '\n...[diff truncated]\n'
    content = content.slice(0, Math.max(0, PATCH_LIMIT_CHARS - suffix.length)) + suffix
  }
  return { content, truncated: state.truncated }
}

function buildFileChangeDiff(filePath, beforeContent, afterContent) {
  const before = beforeContent || ''
  const after = afterContent || ''
  if (isBinaryContent(before) || isBinaryContent(after)) {
    return {
      diff_mode: 'UNSUPPORTED',
      diff_unavailable_reason: '二进制文件无法生成文本 diff',
      patch_truncated: false
    }
  }
  if (utf8Bytes(before) <= SNAPSHOT_LIMIT_BYTES && utf8Bytes(after) <= SNAPSHOT_LIMIT_BYTES) {
    return {
      diff_mode: 'SNAPSHOT',
      before_content: before,
      after_content: after,
      patch_truncated: false
    }
  }
  const patch = buildUnifiedPatch(filePath, before, after)
  return {
    diff_mode: 'PATCH',
    patch_content: patch.content,
    patch_truncated: patch.truncated
  }
}

function asBoolArg(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  }
  return fallback
}

function lineAtIndex(content, index) {
  let lineNumber = 1
  let lineStart = 0
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') {
      lineNumber++
      lineStart = i + 1
    }
  }
  let lineEnd = content.indexOf('\n', index)
  if (lineEnd === -1) lineEnd = content.length
  let lineText = content.slice(lineStart, lineEnd)
  if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1)
  return { lineNumber, lineText }
}

function applyEditMatch(content, oldString, newString, replaceAll) {
  if (oldString === '') {
    return { ok: false, replacements: 0, error: 'old_string 不能为空' }
  }
  const starts = []
  let idx = 0
  while (idx < content.length) {
    const found = content.indexOf(oldString, idx)
    if (found === -1) break
    starts.push(found)
    idx = found + oldString.length
  }
  const count = starts.length
  if (count === 0) {
    return { ok: false, replacements: 0, error: '文件中未找到 old_string' }
  }
  if (count > 1 && !replaceAll) {
    const maxLines = 20
    const maxPreviews = 8
    const occurrenceLines = starts.slice(0, maxLines).map((start) => lineAtIndex(content, start).lineNumber)
    const previewCount = Math.min(maxPreviews, starts.length)
    const previews = []
    for (let i = 0; i < previewCount; i++) {
      const { lineNumber, lineText } = lineAtIndex(content, starts[i])
      const preview = lineText.length > 120 ? lineText.slice(0, 120) + '…' : lineText
      previews.push(`  第 ${lineNumber} 行: ${preview}`)
    }
    const listed = count > maxLines ? `（仅列出前 ${maxLines} 处）` : ''
    return {
      ok: false,
      replacements: 0,
      occurrences: count,
      occurrence_lines: occurrenceLines,
      error: `old_string 在文件中出现 ${count} 次，默认只替换唯一匹配，未执行编辑。`
        + '请在 old_string 中补充更多上下文使其只出现一次，或传入 replace_all=true 以替换全部出现。'
        + `出现位置（行号从 1 起）${listed}：\n`
        + previews.join('\n')
    }
  }
  return {
    ok: true,
    updated: content.split(oldString).join(newString),
    replacements: count
  }
}

function writeEditedFile(resolvedPath, filePathArg, oldString, newString, replaceAll) {
  const content = fs.readFileSync(resolvedPath, 'utf-8')
  const match = applyEditMatch(content, oldString ?? '', newString ?? '', replaceAll)
  if (!match.ok) {
    const out = { success: false, replacements: 0, error: match.error }
    if (match.occurrences != null) {
      out.occurrences = match.occurrences
      out.occurrence_lines = match.occurrence_lines
    }
    return out
  }
  fs.writeFileSync(resolvedPath, match.updated, 'utf-8')
  const lineDelta = computeLineDelta(content, match.updated)
  return {
    success: true,
    replacements: match.replacements,
    file_change: {
      path: filePathArg,
      type: 'MODIFIED',
      lines_added: lineDelta.linesAdded,
      lines_deleted: lineDelta.linesDeleted
    },
    [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePathArg, content, match.updated)
  }
}

module.exports = {
  PRIVATE_DIFF_FIELD,
  SNAPSHOT_LIMIT_BYTES,
  PATCH_LIMIT_CHARS,
  PATCH_CONTEXT_LINES,
  LCS_CELL_LIMIT,
  utf8Bytes,
  splitLines,
  computeLineDelta,
  buildFileChangeDiff,
  asBoolArg,
  writeEditedFile,
}
