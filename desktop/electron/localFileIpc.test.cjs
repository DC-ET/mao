'use strict'

// localFileIpc：通道集合、containment、writeFileWithDiff、IPC 必审批 vs WS 条件审批（§2.4/§8）。
// nativeImage 注入假实现，模块不起 Electron；两条审批路径分别成用例，不互相替代。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { registerLocalFileIpc, writeFileWithDiff, mimeFromPath, detectMimeFromBytes } = require('./localFileIpc.cjs')
const { PRIVATE_DIFF_FIELD } = require('./fileChangeDiff.cjs')

function withTmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-file-ipc-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const fakeNativeImage = {
  createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 16, height: 16 }), resize: () => { throw new Error('resize not expected') } }),
}

function setup(t, { approvalValue = true } = {}) {
  const handlers = {}
  const ipcMain = { handle: (channel, cb) => { handlers[channel] = cb } }
  const approvals = []
  const resolveWorkspacePath = (filePath, workspace) =>
    path.isAbsolute(filePath) ? filePath : (workspace ? path.join(workspace, filePath) : filePath)
  const requestToolApproval = async (toolName, description, sessionId, dangerReason, requestId) => {
    approvals.push({ toolName, description, sessionId, requestId })
    return approvalValue
  }
  const tools = registerLocalFileIpc(ipcMain, { resolveWorkspacePath, requestToolApproval, nativeImage: fakeNativeImage })
  return { handlers, approvals, tools }
}

test('通道名集合与今天一致（§5.7 的 8 条）', () => {
  const { handlers } = setup()
  assert.deepEqual(Object.keys(handlers).sort(), [
    'list-directory',
    'list-workspace-files',
    'local-delivery-read-bytes',
    'local-edit-file',
    'local-read-bytes',
    'local-read-file',
    'local-read-workspace-bytes',
    'local-write-file',
  ].sort())
})

// ---- IPC 写文件：每次都审批 ----

test('IPC local-write-file：审批拒绝时返回 denied，不落盘', async (t) => {
  const dir = withTmpdir(t)
  const { handlers, approvals } = setup(t, { approvalValue: false })
  const result = await handlers['local-write-file'](null, { path: path.join(dir, 'a.txt'), content: 'x' })
  assert.deepEqual(result, { success: false, error: 'User denied file write.' })
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false)
  // 渲染层入口不带 sessionId / requestId（§2.4）
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].toolName, 'write_file')
  assert.equal(approvals[0].sessionId, undefined)
  assert.equal(approvals[0].requestId, undefined)
})

test('IPC local-write-file：批准后写盘并带 file_change / diff', async (t) => {
  const dir = withTmpdir(t)
  const { handlers, approvals } = setup(t, { approvalValue: true })
  const file = path.join(dir, 'a.txt')
  const result = await handlers['local-write-file'](null, { path: file, content: 'one\ntwo\n' })
  assert.equal(result.success, true)
  assert.equal(result.file_change.type, 'CREATED')
  assert.equal(result[PRIVATE_DIFF_FIELD].diff_mode, 'SNAPSHOT')
  assert.equal(approvals.length, 1)
})

test('IPC local-edit-file：每次都审批，拒绝返回 denied', async (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello\n')
  const { handlers, approvals } = setup(t, { approvalValue: false })
  const result = await handlers['local-edit-file'](null, { path: file, old_string: 'hello', new_string: 'hi' })
  assert.deepEqual(result, { success: false, error: 'User denied file edit.' })
  assert.equal(fs.readFileSync(file, 'utf-8'), 'hello\n')
  assert.equal(approvals[0].toolName, 'edit_file')
})

// ---- WS 写文件：仅 needApproval 时审批 ----

test('WS handleLocalWriteFile：needApproval=false 不审批直接写', async (t) => {
  const dir = withTmpdir(t)
  const { tools, approvals } = setup(t, { approvalValue: false })
  const result = await tools.handleLocalWriteFile({ path: 'a.txt', content: 'x' }, dir, 42, false, 'req-1')
  assert.equal(result.success, true)
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf-8'), 'x')
  assert.equal(approvals.length, 0)
})

test('WS handleLocalWriteFile：needApproval=true 且拒绝时返回 denied，带 sessionId/requestId', async (t) => {
  const dir = withTmpdir(t)
  const { tools, approvals } = setup(t, { approvalValue: false })
  const result = await tools.handleLocalWriteFile({ path: 'a.txt', content: 'x' }, dir, 42, true, 'req-1')
  assert.deepEqual(result, { success: false, error: 'User denied file write.' })
  assert.equal(fs.existsSync(path.join(dir, 'a.txt')), false)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].sessionId, 42)
  assert.equal(approvals[0].requestId, 'req-1')
})

test('WS handleLocalEditFile：needApproval=false 直接编辑；拒绝时 denied', async (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello\n')
  const { tools, approvals } = setup(t, { approvalValue: false })

  const denied = await tools.handleLocalEditFile({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, dir, 42, true, 'req-2')
  assert.deepEqual(denied, { success: false, error: 'User denied file edit.' })
  assert.equal(fs.readFileSync(file, 'utf-8'), 'hello\n')

  const ok = await tools.handleLocalEditFile({ path: 'a.txt', old_string: 'hello', new_string: 'hi' }, dir, 42, false, 'req-2')
  assert.equal(ok.success, true)
  assert.equal(fs.readFileSync(file, 'utf-8'), 'hi\n')
  assert.equal(approvals.length, 1)
})

// ---- writeFileWithDiff ----

test('writeFileWithDiff：新文件 CREATED、已存在 MODIFIED 且 diff 非空', (t) => {
  const dir = withTmpdir(t)
  const file = path.join(dir, 'a.txt')

  const created = writeFileWithDiff(file, 'a.txt', 'one\n')
  assert.equal(created.success, true)
  assert.equal(created.file_change.type, 'CREATED')
  // 新文件走原始 split 计数（原实现行为）：'one\n' 按 \n 切为 2 段
  assert.equal(created.file_change.lines_added, 2)
  assert.equal(created[PRIVATE_DIFF_FIELD].diff_mode, 'SNAPSHOT')

  const modified = writeFileWithDiff(file, 'a.txt', 'one\ntwo\n')
  assert.equal(modified.file_change.type, 'MODIFIED')
  assert.equal(modified.file_change.lines_added, 1)
  assert.equal(modified.file_change.lines_deleted, 0)
  const diff = modified[PRIVATE_DIFF_FIELD]
  assert.equal(diff.diff_mode, 'SNAPSHOT')
  assert.ok(diff.before_content.length > 0)
  assert.ok(diff.after_content !== diff.before_content)
})

// ---- list-directory containment / 列举 ----

test('list-directory：拒绝 workspace 之外路径；workspace 内正常列举', async (t) => {
  const dir = withTmpdir(t)
  fs.mkdirSync(path.join(dir, 'sub'))
  fs.writeFileSync(path.join(dir, 'sub', 'file.txt'), 'x')

  const { handlers } = setup(t)
  const outside = await handlers['list-directory'](null, { dirPath: '/tmp', workspace: dir })
  assert.deepEqual(outside, { error: 'Access denied: path outside workspace' })

  const inside = await handlers['list-directory'](null, { dirPath: path.join(dir, 'sub'), workspace: dir })
  assert.equal(inside.entries.length, 1)
  assert.equal(inside.entries[0].name, 'file.txt')
  assert.equal(inside.truncated, false)
})

test('list-workspace-files：workspace 不存在返回 []，过滤命中相对路径', async (t) => {
  const { handlers } = setup(t)
  assert.deepEqual(await handlers['list-workspace-files'](null, { workspace: '/nonexistent-mao-xyz' }), [])

  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'target.txt'), 'x')
  fs.mkdirSync(path.join(dir, 'node_modules'))
  fs.writeFileSync(path.join(dir, 'node_modules', 'target.txt'), 'x')
  const result = await handlers['list-workspace-files'](null, { workspace: dir, filter: 'target' })
  assert.equal(result.length, 1)
  assert.equal(result[0].path, 'target.txt')
})

// ---- 读文件 / 读图 ----

test('WS handleLocalReadFile：缺参数 / 不存在 / 文本读取', async (t) => {
  const dir = withTmpdir(t)
  const { tools } = setup(t)
  assert.equal((await tools.handleLocalReadFile({}, dir, 42)).content, '错误：缺少必填参数 path')
  assert.equal((await tools.handleLocalReadFile({ path: 'nope.txt' }, dir, 42)).content, '错误：文件不存在：nope.txt')

  fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n')
  const r = await tools.handleLocalReadFile({ path: 'a.txt', offset: 1, limit: 1 }, dir, 42)
  assert.equal(r.content, 'l2')
  assert.equal(r.total_lines, 4) // 尾随换行按 split 计为空行（原实现行为）
})

test('IPC local-read-file：PDF 分支返回 data_uri；失败返回 { error }', async (t) => {
  const dir = withTmpdir(t)
  const { handlers } = setup(t)
  const pdf = path.join(dir, 'doc.pdf')
  fs.writeFileSync(pdf, Buffer.from('%PDF-1.4 fake'))

  const r = await handlers['local-read-file'](null, { path: pdf })
  assert.equal(r.media_type, 'pdf')
  assert.ok(r.data_uri.startsWith('data:application/pdf;base64,'))

  const bad = await handlers['local-read-file'](null, { path: path.join(dir, 'missing.txt') })
  assert.ok(bad.error)
})

test('读图：mimeFromPath 按扩展名，PNG 内容走 readLocalImage 返回 data_uri', async (t) => {
  const dir = withTmpdir(t)
  const { handlers, tools } = setup(t)
  assert.equal(mimeFromPath('a.PNG'), 'image/png')
  assert.equal(mimeFromPath('a.txt'), null)
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(detectMimeFromBytes(png), 'image/png')

  const img = path.join(dir, 'pic.png')
  fs.writeFileSync(img, png)
  const ws = await tools.handleLocalReadFile({ path: 'pic.png' }, dir, 42)
  assert.equal(ws.media_type, 'image')
  assert.ok(ws.data_uri.startsWith('data:image/png;base64,'))

  const ipc = await handlers['local-read-file'](null, { path: img })
  assert.equal(ipc.media_type, 'image')
})

test('local-read-bytes / local-read-workspace-bytes：委托形状保持', async (t) => {
  const dir = withTmpdir(t)
  fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([1, 2, 3]))
  const { handlers } = setup(t)

  const bytes = await handlers['local-read-bytes'](null, { path: path.join(dir, 'a.bin') })
  assert.equal(bytes.size, 3)
  assert.ok(bytes.bytes instanceof Buffer)

  const wsBytes = await handlers['local-read-workspace-bytes'](null, { workspace: dir, path: 'a.bin' })
  assert.equal(wsBytes.size, 3)

  const delivery = await handlers['local-delivery-read-bytes'](null, { workspace: dir, path: 'a.bin', maxBytes: 1024 })
  assert.equal(delivery.size, 3)
  assert.ok(delivery.bytes instanceof Buffer)
})
