'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  sanitizeAttachmentName,
  isValidHostKey,
  isValidSessionId,
  resolveAttachmentTarget,
  uniqueName,
  copyLocalAttachment,
  copyLocalAttachmentAsync,
  writeLocalTextFileAsync,
  MAIN_PROCESS_MAX_SIZE_MB,
} = require('./chatAttachment.cjs')

// ─── sanitizeAttachmentName ───

test('sanitizeAttachmentName basename 化与遍历字符', () => {
  assert.equal(sanitizeAttachmentName('../../x'), 'x')
  assert.equal(sanitizeAttachmentName('a/b.txt'), 'b.txt')
  assert.equal(sanitizeAttachmentName('C:\\dir\\sub\\x.txt'), 'x.txt')
  assert.equal(sanitizeAttachmentName('..\\..\\y.log'), 'y.log')
})

test('sanitizeAttachmentName 空串 / . / .. 回落 attachment', () => {
  assert.equal(sanitizeAttachmentName(''), 'attachment')
  assert.equal(sanitizeAttachmentName('.'), 'attachment')
  assert.equal(sanitizeAttachmentName('..'), 'attachment')
  assert.equal(sanitizeAttachmentName('/'), 'attachment')
  assert.equal(sanitizeAttachmentName('...'), 'attachment')
  assert.equal(sanitizeAttachmentName(null), 'attachment')
  assert.equal(sanitizeAttachmentName(undefined), 'attachment')
})

test('sanitizeAttachmentName 剥控制字符与首尾点/空格', () => {
  assert.equal(sanitizeAttachmentName('a\tb.txt'), 'ab.txt')
  assert.equal(sanitizeAttachmentName('a\nb\r.txt'), 'ab.txt')
  assert.equal(sanitizeAttachmentName('file.'), 'file')
  assert.equal(sanitizeAttachmentName('file .txt'), 'file .txt')
  assert.equal(sanitizeAttachmentName('.hidden'), 'hidden')
  assert.equal(sanitizeAttachmentName('x.txt '), 'x.txt')
})

test('sanitizeAttachmentName Windows 保留名加 _ 前缀', () => {
  assert.equal(sanitizeAttachmentName('CON.txt'), '_CON.txt')
  assert.equal(sanitizeAttachmentName('con'), '_con')
  assert.equal(sanitizeAttachmentName('PRN'), '_PRN')
  assert.equal(sanitizeAttachmentName('aux.log'), '_aux.log')
  assert.equal(sanitizeAttachmentName('NUL'), '_NUL')
  assert.equal(sanitizeAttachmentName('COM1'), '_COM1')
  assert.equal(sanitizeAttachmentName('lpt9.dat'), '_lpt9.dat')
  // 普通名不受影响
  assert.equal(sanitizeAttachmentName('CONSOLE.txt'), 'CONSOLE.txt')
  assert.equal(sanitizeAttachmentName('com10.txt'), 'com10.txt')
})

test('sanitizeAttachmentName 超长截断保留扩展名且 ≤100', () => {
  const longStem = 'a'.repeat(200)
  const name = sanitizeAttachmentName(`${longStem}.txt`)
  assert.equal(name, `${'a'.repeat(96)}.txt`)
  assert.ok(name.length <= 100)

  // 无扩展名同样截断
  const noExt = sanitizeAttachmentName('b'.repeat(150))
  assert.equal(noExt, 'b'.repeat(100))

  // 超长扩展名：整体截断
  const longExt = sanitizeAttachmentName(`c.${'d'.repeat(200)}`)
  assert.ok(longExt.length <= 100)

  // 幂等
  assert.equal(sanitizeAttachmentName(name), name)
})

test('sanitizeAttachmentName 全角点等异常字符不逃逸', () => {
  // 全角点不是路径分隔符，保留即可（落盘是单段 basename，无逃逸风险）
  assert.equal(sanitizeAttachmentName('a．b.txt'), 'a．b.txt')
  // 截断后再 strip 仍安全
  const name = sanitizeAttachmentName(`${'e'.repeat(99)}.`)
  assert.ok(name.length <= 100)
  assert.ok(!name.endsWith('.'))
})

// ─── hostKey / sessionId 校验 ───

test('isValidHostKey 拒绝注入形态', () => {
  assert.equal(isValidHostKey('mao.etarch.cn'), true)
  assert.equal(isValidHostKey('10.0.0.8_9080'), true)
  assert.equal(isValidHostKey(''), false)
  assert.equal(isValidHostKey('a/b'), false)
  assert.equal(isValidHostKey('a\\b'), false)
  assert.equal(isValidHostKey('..'), false)
  assert.equal(isValidHostKey('.'), false)
  assert.equal(isValidHostKey(' host'), false)
  assert.equal(isValidHostKey('host\n'), false)
  assert.equal(isValidHostKey(null), false)
})

test('isValidSessionId 只接受正整数', () => {
  assert.equal(isValidSessionId(1), true)
  assert.equal(isValidSessionId('42'), true)
  assert.equal(isValidSessionId(' 42 '), true)
  assert.equal(isValidSessionId(0), false)
  assert.equal(isValidSessionId(-1), false)
  assert.equal(isValidSessionId('1/../../x'), false)
  assert.equal(isValidSessionId('1.5'), false)
  assert.equal(isValidSessionId(''), false)
  assert.equal(isValidSessionId(null), false)
  assert.equal(isValidSessionId(Number.MAX_SAFE_INTEGER + 2), false)
})

// ─── resolveAttachmentTarget ───

test('resolveAttachmentTarget 正常路径位于 home/.mao/attachments/<host>/<sid>/', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-home-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const target = resolveAttachmentTarget(home, 'mao.etarch.cn', 7, 'x.txt')
  assert.equal(
    target,
    path.join(home, '.mao', 'attachments', 'mao.etarch.cn', '7', 'x.txt')
  )
})

test('resolveAttachmentTarget 拒绝 hostKey / sessionId 注入', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  assert.throws(() => resolveAttachmentTarget(home, '', 1, 'x.txt'), /服务器标识/)
  assert.throws(() => resolveAttachmentTarget(home, 'a/b', 1, 'x.txt'), /服务器标识/)
  assert.throws(() => resolveAttachmentTarget(home, '..', 1, 'x.txt'), /服务器标识/)
  assert.throws(() => resolveAttachmentTarget(home, 'host', '1/../../x', 'x.txt'), /会话无效/)
  assert.throws(() => resolveAttachmentTarget(home, 'host', 0, 'x.txt'), /会话无效/)
})

test('resolveAttachmentTarget 嵌套逃逸文件名被 sanitize 收敛', (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-home-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const target = resolveAttachmentTarget(home, 'host', 3, '../../etc/passwd')
  const rel = path.relative(home, target)
  assert.equal(rel, path.join('.mao', 'attachments', 'host', '3', 'passwd'))
})

test('resolveAttachmentTarget home 为符号链接时先 resolve 再断言', (t) => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-real-')))
  const link = `${real}-link`
  fs.symlinkSync(real, link)
  t.after(() => {
    fs.rmSync(real, { recursive: true, force: true })
    fs.rmSync(link, { force: true })
  })
  const target = resolveAttachmentTarget(link, 'host', 5, 'x.txt')
  assert.ok(target.startsWith(real + path.sep), target)
  assert.ok(!target.startsWith(link + path.sep), target)
})

test('resolveAttachmentTarget ~/.mao 存在且非目录时报可读错误', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-home-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  fs.writeFileSync(path.join(home, '.mao'), 'not a dir')
  assert.throws(() => resolveAttachmentTarget(home, 'host', 1, 'x.txt'), /不是目录/)
})

// ─── uniqueName ───

test('uniqueName 无冲突原名、连续冲突递增加后缀', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-uniq-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  assert.equal(uniqueName(dir, 'x.txt'), 'x.txt')
  fs.writeFileSync(path.join(dir, 'x.txt'), '')
  assert.equal(uniqueName(dir, 'x.txt'), 'x-1.txt')
  fs.writeFileSync(path.join(dir, 'x-1.txt'), '')
  // x-1.txt 已存在：跳过取 x-2.txt
  assert.equal(uniqueName(dir, 'x.txt'), 'x-2.txt')
  fs.writeFileSync(path.join(dir, 'x-2.txt'), '')
  assert.equal(uniqueName(dir, 'x.txt'), 'x-3.txt')
})

test('uniqueName 无扩展名与多点扩展名', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-uniq-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'noext'), '')
  assert.equal(uniqueName(dir, 'noext'), 'noext-1')
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), '')
  assert.equal(uniqueName(dir, 'a.tar.gz'), 'a.tar-1.gz')
})

// ─── copyLocalAttachment（IPC handler 的纯逻辑内核） ───

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-copy-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  // macOS /var → /private/var：resolveAttachmentTarget 先 realpath home，期望值必须同口径
  return fs.realpathSync(home)
}

test('copyLocalAttachment 成功：落盘 <home>/.mao/attachments/<host>/<sid>/ 且内容一致', (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'src.txt')
  fs.writeFileSync(src, 'hello attachment')
  const result = copyLocalAttachment({
    sourcePath: src,
    sessionId: 12,
    maxSizeMb: 10,
    homeDir: home,
    hostKey: 'mao.etarch.cn',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const expectedDir = path.join(home, '.mao', 'attachments', 'mao.etarch.cn', '12')
  assert.equal(result.absolutePath, path.join(expectedDir, 'src.txt'))
  assert.equal(fs.readFileSync(result.absolutePath, 'utf8'), 'hello attachment')
})

test('copyLocalAttachment 重名三次追加 -1/-2/-3', (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'dup.bin')
  fs.writeFileSync(src, 'x')
  const results = [1, 2, 3].map((i) =>
    copyLocalAttachment({
      sourcePath: src,
      sessionId: 3,
      maxSizeMb: 10,
      homeDir: home,
      hostKey: 'host',
    })
  )
  assert.deepEqual(results.map((r) => path.basename(r.absolutePath)), ['dup.bin', 'dup-1.bin', 'dup-2.bin'])
})

test('copyLocalAttachment 超限 / 空文件 / 目录 / 符号链接 / 不存在 五个分支', (t) => {
  const home = tempHome(t)
  const base = { sessionId: 9, maxSizeMb: 1, homeDir: home, hostKey: 'host' }

  // 超限
  const big = path.join(home, 'big.bin')
  fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1))
  const tooBig = copyLocalAttachment({ ...base, sourcePath: big })
  assert.equal(tooBig.ok, false)
  assert.match(tooBig.error, /超过/)

  // 空文件
  const empty = path.join(home, 'empty.txt')
  fs.writeFileSync(empty, '')
  const emptyResult = copyLocalAttachment({ ...base, sourcePath: empty })
  assert.equal(emptyResult.ok, false)
  assert.match(emptyResult.error, /为空/)

  // 目录
  const dir = path.join(home, 'folder')
  fs.mkdirSync(dir)
  const dirResult = copyLocalAttachment({ ...base, sourcePath: dir })
  assert.equal(dirResult.ok, false)
  assert.match(dirResult.error, /文件夹/)

  // 符号链接（lstat 拒绝，不跟随）
  const real = path.join(home, 'real.txt')
  fs.writeFileSync(real, 'real content')
  const link = path.join(home, 'link.txt')
  fs.symlinkSync(real, link)
  const linkResult = copyLocalAttachment({ ...base, sourcePath: link })
  assert.equal(linkResult.ok, false)
  assert.match(linkResult.error, /符号链接/)

  // 不存在
  const missing = copyLocalAttachment({ ...base, sourcePath: path.join(home, 'nope.txt') })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不存在/)
})

test('copyLocalAttachment 会话非法 / 路径为空直接拒绝', (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'x.txt')
  fs.writeFileSync(src, 'x')
  const badSession = copyLocalAttachment({ sourcePath: src, sessionId: '1/../../x', homeDir: home, hostKey: 'host' })
  assert.equal(badSession.ok, false)
  assert.match(badSession.error, /会话无效/)
  const noPath = copyLocalAttachment({ sourcePath: '', sessionId: 1, homeDir: home, hostKey: 'host' })
  assert.equal(noPath.ok, false)
})

test('copyLocalAttachment 恶意源文件名被 sanitize 后仍落在会话目录内', (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'x.txt')
  fs.writeFileSync(src, 'payload')
  const result = copyLocalAttachment({
    sourcePath: src,
    sessionId: 4,
    maxSizeMb: 10,
    homeDir: home,
    hostKey: 'host',
  })
  assert.equal(result.ok, true)
  const rel = path.relative(home, result.absolutePath)
  assert.equal(rel, path.join('.mao', 'attachments', 'host', '4', 'x.txt'))
})

test('copyLocalAttachment maxSizeMb 非法时回落默认上限', (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'x.txt')
  fs.writeFileSync(src, 'x')
  const result = copyLocalAttachment({
    sourcePath: src,
    sessionId: 4,
    maxSizeMb: undefined,
    homeDir: home,
    hostKey: 'host',
  })
  assert.equal(result.ok, true)
})

// ─── copyLocalAttachmentAsync（IPC 默认路径：异步拷贝 + 主进程大小封顶） ───

test('copyLocalAttachmentAsync 成功：内容一致且落在会话目录', async (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'src.txt')
  fs.writeFileSync(src, 'async attachment')
  const result = await copyLocalAttachmentAsync({
    sourcePath: src,
    sessionId: 12,
    maxSizeMb: 10,
    homeDir: home,
    hostKey: 'mao.etarch.cn',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.absolutePath, path.join(home, '.mao', 'attachments', 'mao.etarch.cn', '12', 'src.txt'))
  assert.equal(fs.readFileSync(result.absolutePath, 'utf8'), 'async attachment')
})

test('copyLocalAttachmentAsync 主进程硬封顶：渲染层传入 1024 也不放行超限文件', async (t) => {
  const home = tempHome(t)
  // 稀疏文件：lstat.size 超限但不占真实磁盘
  const big = path.join(home, 'huge.bin')
  const fd = fs.openSync(big, 'w')
  fs.ftruncateSync(fd, (MAIN_PROCESS_MAX_SIZE_MB + 100) * 1024 * 1024)
  fs.closeSync(fd)
  const result = await copyLocalAttachmentAsync({
    sourcePath: big,
    sessionId: 5,
    maxSizeMb: 1024,
    homeDir: home,
    hostKey: 'host',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, new RegExp(`${MAIN_PROCESS_MAX_SIZE_MB}MB`))
  // 校验失败不创建附件目录
  assert.equal(fs.existsSync(path.join(home, '.mao', 'attachments')), false)
})

test('copyLocalAttachmentAsync 与同步版同口径：符号链接 / 空文件 / 会话非法均拒', async (t) => {
  const home = tempHome(t)
  const base = { sessionId: 9, maxSizeMb: 10, homeDir: home, hostKey: 'host' }
  const real = path.join(home, 'real.txt')
  fs.writeFileSync(real, 'real')
  const link = path.join(home, 'link.txt')
  fs.symlinkSync(real, link)
  const linkResult = await copyLocalAttachmentAsync({ ...base, sourcePath: link })
  assert.equal(linkResult.ok, false)
  assert.match(linkResult.error, /符号链接/)
  const empty = path.join(home, 'empty.txt')
  fs.writeFileSync(empty, '')
  const emptyResult = await copyLocalAttachmentAsync({ ...base, sourcePath: empty })
  assert.equal(emptyResult.ok, false)
  assert.match(emptyResult.error, /为空/)
  const badSession = await copyLocalAttachmentAsync({ sourcePath: real, sessionId: '1/../../x', homeDir: home, hostKey: 'host' })
  assert.equal(badSession.ok, false)
  assert.match(badSession.error, /会话无效/)
})

test('copyLocalAttachmentAsync 拷贝过程失败返回 ok:false 不抛出', async (t) => {
  const home = tempHome(t)
  const src = path.join(home, 'x.txt')
  fs.writeFileSync(src, 'x')
  const fsImpl = {
    ...fs,
    promises: {
      copyFile: async () => { throw new Error('disk full') },
    },
  }
  const result = await copyLocalAttachmentAsync({
    sourcePath: src,
    sessionId: 1,
    maxSizeMb: 10,
    homeDir: home,
    hostKey: 'host',
    fsImpl,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /disk full/)
})

// ─── writeLocalTextFileAsync（dump_user_messages 的 LOCAL 落点） ───

test('writeLocalTextFileAsync 成功：落在会话附件目录并返回本机绝对路径与字节数', async (t) => {
  const home = tempHome(t)
  const content = '14084181,14084183,14084185'
  const result = await writeLocalTextFileAsync({
    fileName: 'user-message-1042.txt',
    content,
    sessionId: 9,
    homeDir: home,
    hostKey: 'mao.etarch.cn',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const expected = path.join(home, '.mao', 'attachments', 'mao.etarch.cn', '9', 'user-message-1042.txt')
  assert.equal(result.absolutePath, expected)
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'))
  assert.equal(fs.readFileSync(expected, 'utf8'), content)
})

test('writeLocalTextFileAsync dedupe=false（dump 幂等）：重复写入覆盖同一文件，不产生 -1 副本', async (t) => {
  const home = tempHome(t)
  const base = { fileName: 'user-message-7.txt', sessionId: 3, homeDir: home, hostKey: 'host', dedupe: false }
  const first = await writeLocalTextFileAsync({ ...base, content: 'v1' })
  const second = await writeLocalTextFileAsync({ ...base, content: 'v2' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.absolutePath, first.absolutePath)
  const dir = path.join(home, '.mao', 'attachments', 'host', '3')
  assert.deepEqual(fs.readdirSync(dir), ['user-message-7.txt'])
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), 'v2')
})

test('writeLocalTextFileAsync 默认同名避重（粘贴附件语义）：追加 -1 副本，不覆盖已有引用', async (t) => {
  const home = tempHome(t)
  const base = { fileName: 'pasted-text-1.txt', sessionId: 3, homeDir: home, hostKey: 'host' }
  const first = await writeLocalTextFileAsync({ ...base, content: 'first batch' })
  const second = await writeLocalTextFileAsync({ ...base, content: 'second batch' })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.notEqual(second.absolutePath, first.absolutePath)
  const dir = path.join(home, '.mao', 'attachments', 'host', '3')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['pasted-text-1-1.txt', 'pasted-text-1.txt'])
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), 'first batch')
  assert.equal(fs.readFileSync(second.absolutePath, 'utf8'), 'second batch')
})

test('writeLocalTextFileAsync 会话非法 / hostKey 非法 / 文件名缺失 / 内容非字符串均拒且不建目录', async (t) => {
  const home = tempHome(t)
  const base = { fileName: 'a.txt', content: 'x', sessionId: 1, homeDir: home, hostKey: 'host' }
  const badSession = await writeLocalTextFileAsync({ ...base, sessionId: '1/../../x' })
  assert.equal(badSession.ok, false)
  assert.match(badSession.error, /会话无效/)
  const badHost = await writeLocalTextFileAsync({ ...base, hostKey: '../escape' })
  assert.equal(badHost.ok, false)
  assert.match(badHost.error, /服务器标识/)
  const noName = await writeLocalTextFileAsync({ ...base, fileName: undefined })
  assert.equal(noName.ok, false)
  assert.match(noName.error, /文件名无效/)
  const badContent = await writeLocalTextFileAsync({ ...base, content: null })
  assert.equal(badContent.ok, false)
  assert.match(badContent.error, /文本内容无效/)
  assert.equal(fs.existsSync(path.join(home, '.mao')), false)
})

test('writeLocalTextFileAsync 穿越文件名被 sanitize 后仍落在会话目录内', async (t) => {
  const home = tempHome(t)
  const result = await writeLocalTextFileAsync({
    fileName: '../../user-message-9.txt',
    content: 'x',
    sessionId: 4,
    homeDir: home,
    hostKey: 'host',
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  const rel = path.relative(home, result.absolutePath)
  assert.equal(rel, path.join('.mao', 'attachments', 'host', '4', 'user-message-9.txt'))
})

test('writeLocalTextFileAsync 超过大小上限时拒绝', async (t) => {
  const home = tempHome(t)
  const result = await writeLocalTextFileAsync({
    fileName: 'big.txt',
    content: 'x'.repeat(2000),
    sessionId: 5,
    maxSizeMb: 0.001,
    homeDir: home,
    hostKey: 'host',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /超过/)
})

test('writeLocalTextFileAsync 写盘失败返回 ok:false 不抛出', async (t) => {
  const home = tempHome(t)
  const fsImpl = {
    ...fs,
    promises: {
      writeFile: async () => { throw new Error('read-only file system') },
    },
  }
  const result = await writeLocalTextFileAsync({
    fileName: 'a.txt',
    content: 'x',
    sessionId: 1,
    homeDir: home,
    hostKey: 'host',
    fsImpl,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /read-only file system/)
})
