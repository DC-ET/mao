'use strict'

// file_fetch 委托读取的 containment 校验（localWorkspaceRead.cjs，方案 2026-11-18 §5.2-1）。
// node --test（desktop/electron/*.test.cjs），与 localFileBytes.test.cjs 同跑法。

const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { resolveContainedWorkspacePath, readWorkspaceBytes, readDeliveryWorkspaceBytes } = require('./localWorkspaceRead.cjs')

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
  // 实现返回 realpath。macOS 上 /var 归一到 /private/var，不能拿 path.resolve 的词法结果比对。
  assert.strictEqual(resolved.path, fs.realpathSync(path.join(WORKSPACE, 'screenshots', 'a.png')))
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

test('workspace 带尾分隔符仍 containment', () => {
  const withSep = WORKSPACE + path.sep
  const resolved = resolveContainedWorkspacePath(withSep, 'screenshots/a.png')
  assert.strictEqual(resolved.error, undefined)
  assert.strictEqual(resolved.path, fs.realpathSync(path.join(WORKSPACE, 'screenshots', 'a.png')))
})

test('大小写不敏感文件系统上，大小写混写的 workspace 仍 containment', (t) => {
  // realpath 不改写大小写，不能靠 realpath 字符串相等判断。用探测文件：
  // Windows / 默认 macOS 能打开大小写不同的同一路径；Linux CI 不能，大写工作区应判不存在。
  const marker = path.join(WORKSPACE, 'CaseMarker')
  fs.writeFileSync(marker, 'x')
  const insensitive = fs.existsSync(path.join(WORKSPACE, 'casemarker'))
  fs.rmSync(marker, { force: true })
  if (!insensitive) {
    t.skip('当前文件系统大小写敏感，大写路径不是同一工作区')
    return
  }
  const caseInsensitive = resolveContainedWorkspacePath(WORKSPACE.toUpperCase(), 'screenshots/a.png')
  assert.strictEqual(caseInsensitive.error, undefined)
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

// ── delivery_fetch（统一发送媒体方案 §6.2）：相对或 workspace 内绝对路径、普通文件、非符号链接、maxBytes ──

test('delivery：相对路径 / workspace 内绝对路径都读到字节', () => {
  const rel = readDeliveryWorkspaceBytes(WORKSPACE, 'screenshots/a.png', { maxBytes: 1024 })
  assert.strictEqual(rel.error, undefined)
  assert.deepStrictEqual([...rel.bytes], [0x89, 0x50, 0x4e, 0x47])
  const absolute = path.join(WORKSPACE, 'screenshots', 'a.png')
  const abs = readDeliveryWorkspaceBytes(WORKSPACE, absolute, { maxBytes: 1024 })
  assert.strictEqual(abs.error, undefined)
  assert.deepStrictEqual([...abs.bytes], [0x89, 0x50, 0x4e, 0x47])
})

test('delivery：workspace 外绝对路径 / 越界 / 反斜杠 / NUL 一律拒绝', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-delivery-outside-'))
  try {
    fs.writeFileSync(path.join(outside, 'x.pdf'), 'x')
    for (const bad of [
      path.join(outside, 'x.pdf'),
      '../escape.png',
      'a\\b.png',
      'a\0b.png',
      '',
    ]) {
      const resolved = readDeliveryWorkspaceBytes(WORKSPACE, bad, { maxBytes: 1024 })
      assert.strictEqual(typeof resolved.error, 'string', `应拒绝：${JSON.stringify(bad)}`)
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('delivery：目标本身是符号链接被拒（不跟到目标）', () => {
  const link = path.join(WORKSPACE, 'screenshots', 'link.png')
  try {
    fs.symlinkSync(path.join(WORKSPACE, 'screenshots', 'a.png'), link, 'file')
  } catch {
    return // Windows 无符号链接权限时跳过
  }
  try {
    assert.strictEqual(readDeliveryWorkspaceBytes(WORKSPACE, 'screenshots/link.png').error, '不接受符号链接')
  } finally {
    fs.rmSync(link, { force: true })
  }
})

test('delivery：帧内 maxBytes 作为读取上限（图片 20MB 场景不再按 30MB 读整份）', () => {
  const big = path.join(WORKSPACE, 'screenshots', 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(8, 1))
  try {
    const capped = readDeliveryWorkspaceBytes(WORKSPACE, 'screenshots/big.bin', { maxBytes: 4 })
    assert.match(capped.error, /文件过大/)
    const ok = readDeliveryWorkspaceBytes(WORKSPACE, 'screenshots/big.bin', { maxBytes: 8 })
    assert.strictEqual(ok.error, undefined)
    assert.strictEqual(ok.size, 8)
  } finally {
    fs.rmSync(big, { force: true })
  }
})
