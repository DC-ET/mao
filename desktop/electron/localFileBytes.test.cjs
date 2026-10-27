'use strict'

// localFileBytes：类型校验 / 大小上限 / 读取（技术方案 §5.2 / §9）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { readFileBytes, DEFAULT_MAX_BYTES } = require('./localFileBytes.cjs')

function withTmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-file-bytes-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('正常读取返回 Buffer 与 size', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.bin')
  fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))
  const result = readFileBytes(file)
  assert.ok(result.bytes instanceof Buffer)
  assert.equal(result.error, undefined)
  assert.equal(result.size, 7)
  assert.deepEqual([...result.bytes], [0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
})

test('空文件允许读取（size 0，空态由上层决定）', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'empty.bin')
  fs.writeFileSync(file, '')
  const result = readFileBytes(file)
  assert.equal(result.error, undefined)
  assert.equal(result.size, 0)
})

test('目录被拒绝', (t) => {
  const dir = withTmpdir(t)
  const result = readFileBytes(dir)
  assert.equal(result.bytes, undefined)
  assert.match(result.error, /不是普通文件/)
})

test('符号链接被拒绝', (t) => {
  const dir = withTmpdir(t)
  const target = path.join(dir, 'target.bin')
  const link = path.join(dir, 'link.bin')
  fs.writeFileSync(target, 'x')
  fs.symlinkSync(target, link)
  const result = readFileBytes(link)
  assert.equal(result.bytes, undefined)
  assert.match(result.error, /符号链接/)
})

test('超过 maxBytes 被拒绝且提示含实际上限', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'big.bin')
  fs.writeFileSync(file, Buffer.alloc(2048))
  const result = readFileBytes(file, { maxBytes: 1024 })
  assert.equal(result.bytes, undefined)
  assert.match(result.error, /文件过大/)
  assert.match(result.error, /1\.0KB/)
})

test('默认上限为 64MB（LOCAL_READ_BYTES_MAX）', () => {
  assert.equal(DEFAULT_MAX_BYTES, 64 * 1024 * 1024)
})
