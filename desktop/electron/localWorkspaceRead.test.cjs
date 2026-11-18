'use strict'

// file_fetch 委托读取的 containment 校验（localWorkspaceRead.cjs，方案 2026-11-18 §5.2-1）。
// node --test（desktop/electron/*.test.cjs），与 localFileBytes.test.cjs 同跑法。

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { resolveContainedWorkspacePath, readWorkspaceBytes } = require('./localWorkspaceRead.cjs')

const WORKSPACE = path.join(os.tmpdir(), 'mao-local-workspace-read-test')

test.before(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORKSPACE, 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(WORKSPACE, 'screenshots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
})

test.after(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
})

test('正常相对路径解析为 workspace 内绝对路径', () => {
  const resolved = resolveContainedWorkspacePath(WORKSPACE, 'screenshots/a.png')
  assert.strictEqual(resolved.error, undefined)
  assert.strictEqual(resolved.path, path.resolve(WORKSPACE, 'screenshots', 'a.png'))
})

test('拒绝越界与非法路径', () => {
  for (const bad of [
    '../escape.png',
    'a/../../escape.png',
    '/abs/a.png',
    'C:/a.png',
    'a\\b.png',
    '\\\\host\\share\\a.png',
    'dir/./a.png',
    '',
    '',
  ]) {
    const resolved = resolveContainedWorkspacePath(WORKSPACE, bad)
    assert.strictEqual(resolved.error !== undefined, true, `应拒绝：${bad}`)
  }
})

test('拒绝非法 workspace 与空段路径', () => {
  assert.strictEqual(resolveContainedWorkspacePath('', 'a.png').error, '缺少工作区路径')
  assert.strictEqual(resolveContainedWorkspacePath(WORKSPACE, 'screenshots//a.png').error, '文件路径不合法')
})

test('workspace 带尾分隔符 / 大小写混写仍 containment（Windows 口径）', () => {
  const withSep = WORKSPACE + path.sep
  const resolved = resolveContainedWorkspacePath(withSep, 'screenshots/a.png')
  assert.strictEqual(resolved.error, undefined)
  // path.win32.relative 大小写不敏感：不同大小写写法的同一路径不判越界
  const mixed = WORKSPACE.toUpperCase()
  if (mixed !== WORKSPACE) {
    const caseInsensitive = resolveContainedWorkspacePath(mixed, 'screenshots/a.png')
    assert.strictEqual(caseInsensitive.error, undefined)
  }
})

test('盘符大小写不同的绝对路径逃逸被拒（仅当盘符真不同时）', () => {
  // 与 workspace 同盘、不同小写盘符的组合在 resolve 后 relative 为空串/合法—— containment 的
  // 关键是「不同盘」组合必须被判越界而非误拼；Windows 上跨盘 relative 返回带盘符的绝对路径。
  const resolved = resolveContainedWorkspacePath(WORKSPACE, 'x:y.png')
  assert.strictEqual(resolved.error, '文件路径不合法') // 段内含 ':'，直接拒绝
})

test('readWorkspaceBytes 读到字节；越界返回 error', () => {
  const ok = readWorkspaceBytes(WORKSPACE, 'screenshots/a.png')
  assert.strictEqual(ok.error, undefined)
  assert.strictEqual(Buffer.isBuffer(ok.bytes), true)
  assert.strictEqual(ok.size, 4)
  assert.deepStrictEqual([...ok.bytes], [0x89, 0x50, 0x4e, 0x47])

  const escaped = readWorkspaceBytes(WORKSPACE, '../escape.png')
  assert.strictEqual(escaped.error, '文件路径不合法')
})

test('文件不存在按读取错误口径返回（不冒充越界）', () => {
  assert.strictEqual(readWorkspaceBytes(WORKSPACE, 'screenshots/missing.png').error, '文件不存在')
})

test('父级目录 symlink 指向外部时穿出被拒（realpath containment）', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-outside-'))
  fs.writeFileSync(path.join(outside, 'secret.png'), 'secret')
  let linked = false
  try {
    fs.symlinkSync(outside, path.join(WORKSPACE, 'screenshots', 'link'), 'dir')
    linked = true
  } catch {
    return // Windows 无符号链接权限时跳过
  }
  try {
    const escaped = readWorkspaceBytes(WORKSPACE, 'screenshots/link/secret.png')
    // 词法上在 workspace 内；realpath 归一后在外部 → 拒绝（评审 P2-4）
    assert.strictEqual(escaped.error, '文件路径越界')
  } finally {
    if (linked) fs.rmSync(path.join(WORKSPACE, 'screenshots', 'link'), { force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})
