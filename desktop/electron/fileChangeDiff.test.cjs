'use strict'

// fileChangeDiff：diff 模式判定 / 截断 / 编辑匹配 / 写盘一致性（技术方案 2026-11-19 §8）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  PRIVATE_DIFF_FIELD,
  SNAPSHOT_LIMIT_BYTES,
  PATCH_LIMIT_CHARS,
  computeLineDelta,
  buildFileChangeDiff,
  asBoolArg,
  writeEditedFile,
} = require('./fileChangeDiff.cjs')

function withTmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-file-diff-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('含 NUL 的内容（前 8192 字符内）→ UNSUPPORTED，原因含「二进制」', () => {
  const before = 'normal text\n'
  const after = 'ok\n' + String.fromCharCode(0) + 'nul-byte\n'
  const diff = buildFileChangeDiff('bin.txt', before, after)
  assert.equal(diff.diff_mode, 'UNSUPPORTED')
  assert.ok(diff.diff_unavailable_reason.includes('二进制'))
  assert.equal(diff.patch_truncated, false)
})

test('两侧都小于 512 KiB → SNAPSHOT，带 before/after 全文', () => {
  const before = 'line1\nline2\n'
  const after = 'line1\nline2-changed\n'
  const diff = buildFileChangeDiff('a.txt', before, after)
  assert.equal(diff.diff_mode, 'SNAPSHOT')
  assert.equal(diff.before_content, before)
  assert.equal(diff.after_content, after)
  assert.equal(diff.patch_truncated, false)
})

test('任一侧超过 512 KiB → PATCH，补丁含 unified 头且上下文 3 行', (t) => {
  const lines = Array.from({ length: 60000 }, (_, i) => `line${i + 1}`)
  const before = lines.join('\n')
  const afterLines = [...lines.slice(0, 30000), `line30001-changed`, ...lines.slice(30001)]
  const after = afterLines.join('\n')
  assert.ok(Buffer.byteLength(before, 'utf-8') > SNAPSHOT_LIMIT_BYTES)

  const diff = buildFileChangeDiff('big.txt', before, after)
  assert.equal(diff.diff_mode, 'PATCH')
  assert.ok(diff.patch_content.startsWith('--- a/big.txt\n'))
  assert.ok(diff.patch_content.includes('+++ b/big.txt\n'))
  assert.ok(diff.patch_content.includes('@@ -'))
  // 上下文 3 行：变更行 30001，第一行上下文是 29998，且 29997 不应出现
  assert.ok(diff.patch_content.includes(' line29998\n'))
  assert.ok(diff.patch_content.includes('-line30001\n'))
  assert.ok(diff.patch_content.includes('+line30001-changed\n'))
  assert.ok(!diff.patch_content.includes(' line29997\n'))
  assert.equal(diff.patch_truncated, false)
})

test('超过 256 Ki 字符 → patch_truncated=true，正文以 ...[diff truncated] 结尾', () => {
  const before = 'a'.repeat(600 * 1024)
  const after = 'a'.repeat(300 * 1024) + 'b'.repeat(300 * 1024)
  const diff = buildFileChangeDiff('huge.txt', before, after)
  assert.equal(diff.diff_mode, 'PATCH')
  assert.equal(diff.patch_truncated, true)
  assert.ok(diff.patch_content.endsWith('...[diff truncated]\n'))
  assert.ok(diff.patch_content.length <= PATCH_LIMIT_CHARS + 32)
})

test('computeLineDelta：新增 / 删除 / 改写（尾随换行按原实现计为空行）', () => {
  assert.deepEqual(computeLineDelta('', 'a\nb\n'), { linesAdded: 3, linesDeleted: 0 })
  assert.deepEqual(computeLineDelta('a\nb\n', ''), { linesAdded: 0, linesDeleted: 3 })
  assert.deepEqual(computeLineDelta('a\nb\nc\n', 'a\nB\nc\n'), { linesAdded: 1, linesDeleted: 1 })
  assert.deepEqual(computeLineDelta('same\n', 'same\n'), { linesAdded: 0, linesDeleted: 0 })
})

test('asBoolArg：真值 / 假值 / 其它走 fallback', () => {
  assert.equal(asBoolArg(true), true)
  assert.equal(asBoolArg(1), true)
  assert.equal(asBoolArg('yes'), true)
  assert.equal(asBoolArg('true'), true)
  assert.equal(asBoolArg(false), false)
  assert.equal(asBoolArg(0), false)
  assert.equal(asBoolArg('no'), false)
  assert.equal(asBoolArg(''), false)
  assert.equal(asBoolArg('weird', true), true)
  assert.equal(asBoolArg('weird', false), false)
  assert.equal(asBoolArg(null, false), false)
})

test('writeEditedFile：空 old_string 失败', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'one\n')
  const result = writeEditedFile(file, 'a.txt', '', 'x', false)
  assert.equal(result.success, false)
  assert.ok(result.error.includes('old_string 不能为空'))
  assert.equal(fs.readFileSync(file, 'utf-8'), 'one\n')
})

test('writeEditedFile：找不到 old_string 失败', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'one\n')
  const result = writeEditedFile(file, 'a.txt', 'missing', 'x', false)
  assert.equal(result.success, false)
  assert.ok(result.error.includes('未找到'))
})

test('writeEditedFile：多处匹配且未 replace_all 失败，带出现行号', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'dup\nmid\ndup\n')
  const result = writeEditedFile(file, 'a.txt', 'dup', 'x', false)
  assert.equal(result.success, false)
  assert.equal(result.occurrences, 2)
  assert.deepEqual(result.occurrence_lines, [1, 3])
  assert.equal(fs.readFileSync(file, 'utf-8'), 'dup\nmid\ndup\n')
})

test('writeEditedFile：唯一匹配替换；replace_all 替换全部', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'dup\nmid\ndup\n')

  const single = writeEditedFile(file, 'a.txt', 'mid', 'MID', false)
  assert.equal(single.success, true)
  assert.equal(single.replacements, 1)
  assert.equal(fs.readFileSync(file, 'utf-8'), 'dup\nMID\ndup\n')

  const all = writeEditedFile(file, 'a.txt', 'dup', 'DUP', true)
  assert.equal(all.success, true)
  assert.equal(all.replacements, 2)
  assert.equal(fs.readFileSync(file, 'utf-8'), 'DUP\nMID\nDUP\n')
})

test('writeEditedFile：lines_added/lines_deleted 与 file_change_diff 一致', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'one\ntwo\nthree\n')
  const result = writeEditedFile(file, 'a.txt', 'two', 'two-A\ntwo-B', false)
  assert.equal(result.success, true)
  assert.equal(result.file_change.type, 'MODIFIED')
  assert.equal(result.file_change.lines_added, 2)
  assert.equal(result.file_change.lines_deleted, 1)

  const diff = result[PRIVATE_DIFF_FIELD]
  assert.equal(diff.diff_mode, 'SNAPSHOT')
  const afterLines = diff.after_content.split('\n').length
  const beforeLines = diff.before_content.split('\n').length
  assert.equal(afterLines - beforeLines, result.file_change.lines_added - result.file_change.lines_deleted)
})
