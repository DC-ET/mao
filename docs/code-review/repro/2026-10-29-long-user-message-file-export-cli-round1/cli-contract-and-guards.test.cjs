'use strict'
/**
 * 第 3 轮审查复现脚本（agent-cli 增量：LOCAL 落盘 write_local_text_file）
 *
 * 覆盖四项待确认：
 *   A 契约：CLI `handleWriteLocalTextFile` 的回包被**真实**服务端 `DumpUserMessagesTool` 正确解析（path / error / 幂等覆盖）；
 *   B 路径收敛：fileName 注入、会话号非法、目标为符号链接；
 *   C 审批门禁：needApproval=false 短路之前的硬门禁（规则合法性 / 工作区信任 / 默认拒绝清单）仍然生效，
 *     并验证 LocalExecutor 端到端在「未信任工作区」下不落盘、回 tool_error；
 *   D 既有链路：CLI 的 read_file 能读到 dump 返回的路径（模型下一步可用），既有工具行为由仓库 587 用例覆盖。
 *
 * 运行（仓库根目录）：
 *   node --test docs/code-review/repro/2026-10-29-long-user-message-file-export-cli-round1/cli-contract-and-guards.test.cjs
 * 依赖：agent-cli 已 `npm run build`（读 dist），backend-ts 已 `npm run build`（读 dist）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const REPO = path.resolve(__dirname, '../../../..')
const CLI_DIST = path.join(REPO, 'agent-cli/dist')
const BE_DIST = path.join(REPO, 'backend-ts/dist')
const SESSION_ID = 7701

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

/** HOME / config.json 必须在 require CLI 模块之前就位（RUNTIME_DIR 是模块加载时的常量）。 */
function setupHome({ trusted = true, trustPath = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-r3-home-'))
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-r3-ws-'))
  process.env.HOME = home
  process.env.USERPROFILE = home
  const cfgDir = path.join(home, '.mao', 'agent-cli')
  fs.mkdirSync(cfgDir, { recursive: true })
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ trustedWorkspaces: trusted ? [fs.realpathSync(trustPath ?? ws)] : [] }),
  )
  clearCliModules()
  return { home, ws }
}

function clearCliModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(CLI_DIST)) delete require.cache[key]
  }
}

function cliFiles() {
  return require(path.join(CLI_DIST, 'local/tools/files.js'))
}

function userMessagesDir(home, sessionId = SESSION_ID) {
  return path.join(home, '.mao', 'agent-cli', 'runtime', String(sessionId), 'userMessages')
}

const cliApproval = () => require(path.join(CLI_DIST, 'local/approval.js'))

function policy(overrides = {}) {
  return {
    yolo: false, force: false, onApproval: 'fail', approveRules: [],
    strictDangerCheck: false, iKnowWhatImDoing: false, stdoutIsTty: false, stdinIsTty: false,
    ...overrides,
  }
}

test.after(() => {
  for (const k of ['HOME', 'USERPROFILE']) {
    if (savedHome[k] === undefined) delete process.env[k]
    else process.env[k] = savedHome[k]
  }
})

// ─────────────── A. 与服务端 dump_user_messages 的契约 ───────────────

test('A1 契约：CLI 回包被真实 DumpUserMessagesTool(LOCAL) 解析为绝对路径，内容一致', async () => {
  const { home } = setupHome()
  const { handleWriteLocalTextFile } = cliFiles()
  const { DumpUserMessagesTool } = await import(pathToFileURL(path.join(BE_DIST, 'harness/tool/impl/dump-user-messages-tool.js')).href)
  const { RuntimeDataResolver } = await import(pathToFileURL(path.join(BE_DIST, 'harness/runtime/runtime-data-resolver.js')).href)

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-r3-runtime-'))
  let content = '14084181,14084183'
  const tool = new DumpUserMessagesTool(
    {
      getRecentUserMessages: async (_sid, limit) => [{ id: 1042, role: 'USER', content }].slice(-limit),
      extractVisibleText: (c) => c,
    },
    RuntimeDataResolver.forTest(runtimeDir, home),
    {
      // 镜像 CLI 的 WS 回包：execute → handleWriteLocalTextFile → JSON.stringify
      execute: async (sessionId, toolName, argsJson) => {
        assert.equal(toolName, 'write_local_text_file')
        return JSON.stringify(await handleWriteLocalTextFile(JSON.parse(argsJson), sessionId))
      },
    },
    { selectById: async () => ({ executionMode: 'LOCAL' }) },
  )

  const first = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), SESSION_ID, 7, null))
  const expected = path.join(userMessagesDir(home), 'user-message-1042.txt')
  assert.equal(first.count, 1)
  assert.deepEqual(
    { messageId: first.files[0].messageId, path: first.files[0].path },
    { messageId: 1042, path: expected },
  )
  assert.equal(fs.readFileSync(expected, 'utf8'), content)

  // 幂等：同消息重复导出覆盖同一文件，不产生 -1 副本
  content = '14090001,14090002'
  const second = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), SESSION_ID, 7, null))
  assert.equal(second.files[0].path, first.files[0].path)
  assert.deepEqual(fs.readdirSync(userMessagesDir(home)), ['user-message-1042.txt'])
  assert.equal(fs.readFileSync(expected, 'utf8'), '14090001,14090002')
})

test('A2 契约：CLI 失败态回 { error } 时服务端工具按「该条失败」记录，不冒充成功', async () => {
  const { home } = setupHome()
  const { handleWriteLocalTextFile } = cliFiles()
  const { DumpUserMessagesTool } = await import(pathToFileURL(path.join(BE_DIST, 'harness/tool/impl/dump-user-messages-tool.js')).href)
  const { RuntimeDataResolver } = await import(pathToFileURL(path.join(BE_DIST, 'harness/runtime/runtime-data-resolver.js')).href)

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-cli-r3-runtime-'))
  const tool = new DumpUserMessagesTool(
    {
      getRecentUserMessages: async () => [{ id: 5, role: 'USER', content: 'x' }],
      extractVisibleText: (c) => c,
    },
    RuntimeDataResolver.forTest(runtimeDir, home),
    {
      execute: async (_sid, _name, argsJson) => {
        const args = JSON.parse(argsJson)
        // 与 CLI 的 handler 同源调用，但把 content 换成非法值 → CLI 回 { error: '文本内容无效' }
        return JSON.stringify(await handleWriteLocalTextFile({ fileName: args.fileName, content: 123 }, SESSION_ID))
      },
    },
    { selectById: async () => ({ executionMode: 'LOCAL' }) },
  )

  const out = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), SESSION_ID, 7, null))
  assert.equal(out.files[0].path, undefined)
  assert.match(String(out.files[0].error), /文本内容无效/)
  assert.match(String(out.message), /未能导出用户消息/)
})

// ─────────────── B. 路径收敛 ───────────────

test('B1 路径收敛：fileName 注入 / 非法会话号全部收敛在 userMessages 内或直接报错', async () => {
  const { home } = setupHome()
  const { handleWriteLocalTextFile } = cliFiles()
  const dir = userMessagesDir(home)
  const outside = path.join(home, 'outside')
  fs.mkdirSync(outside, { recursive: true })

  const injections = [
    '../../escape-a.txt',
    'a/b/../../escape-b.txt',
    '/etc/passwd',
    '..\\..\\escape-c.txt',
    '....//escape-d.txt',
    '\u0000con\u001ftrol.txt',
  ]
  for (const fileName of injections) {
    const result = await handleWriteLocalTextFile({ fileName, content: 'x' }, SESSION_ID)
    if (result.error) continue
    const rel = path.relative(dir, String(result.path))
    assert.equal(rel.startsWith('..'), false, `${JSON.stringify(fileName)} 逃出 userMessages: ${result.path}`)
    assert.equal(path.isAbsolute(rel), false, `${JSON.stringify(fileName)} 逃出 userMessages`)
    assert.equal(fs.existsSync(String(result.path)), true)
  }
  // 直系注入不得在 userMessages 之外留下任何文件
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.equal(fs.existsSync(path.join(home, 'escape-a.txt')), false)

  // 非法会话号
  for (const sessionId of [0, -1, 1.5, NaN, '3']) {
    const result = await handleWriteLocalTextFile({ fileName: 'a.txt', content: 'x' }, sessionId)
    assert.deepEqual(result, { error: '会话无效，无法确定落盘目录' }, `sessionId=${String(sessionId)} 未被拒绝`)
  }
  // 非法文件名
  for (const fileName of [undefined, '', '   ', '.', '..', '../', '/', 'a'.repeat(101), 42]) {
    const result = await handleWriteLocalTextFile({ fileName, content: 'x' }, SESSION_ID)
    assert.deepEqual(result, { error: '文件名无效' }, `fileName=${JSON.stringify(fileName)} 未被拒绝`)
  }
})

test('B2 符号链接：目标文件是软链时拒绝写入，链外文件不被改写', async () => {
  const { home } = setupHome()
  const { handleWriteLocalTextFile } = cliFiles()
  const dir = userMessagesDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const victim = path.join(home, 'victim.txt')
  fs.writeFileSync(victim, 'ORIGINAL')
  fs.symlinkSync(victim, path.join(dir, 'user-message-1.txt'))

  const result = await handleWriteLocalTextFile({ fileName: 'user-message-1.txt', content: 'HACKED' }, SESSION_ID)
  assert.match(String(result.error), /符号链接/)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'ORIGINAL')
})

test('B3 记录性核查：userMessages 目录整体被替换为软链时（父级软链）落点在哪', async () => {
  const { home } = setupHome()
  const { handleWriteLocalTextFile } = cliFiles()
  const runtimeSession = path.join(home, '.mao', 'agent-cli', 'runtime', String(SESSION_ID))
  const outside = path.join(home, 'outside-dir')
  fs.mkdirSync(outside, { recursive: true })
  fs.mkdirSync(runtimeSession, { recursive: true })
  fs.symlinkSync(outside, path.join(runtimeSession, 'userMessages'))

  const result = await handleWriteLocalTextFile({ fileName: 'user-message-9.txt', content: 'x' }, SESSION_ID)
  const landedOutside = fs.existsSync(path.join(outside, 'user-message-9.txt'))
  console.log('[B3] result =', JSON.stringify(result), '| 落在软链目标目录 =', landedOutside)
  // 说明性断言：仅记录行为（与桌面端 writeLocalTextFileAsync / 既有 write_file 同为「只拒绝目标本身是软链」）
  assert.ok(result.path !== undefined || result.error !== undefined)
})

// ─────────────── D. 既有链路不受影响 / 返回值可用 ───────────────

test('D1 端到端：dump 出的路径可被 CLI 的 read_file 直接读取（既有工具行为不变）', async () => {
  const { home, ws } = setupHome({ trusted: true })
  const { LocalExecutor } = require(path.join(CLI_DIST, 'local/executor.js'))
  const { handleWriteLocalTextFile } = cliFiles()
  const content = '14084181,14084183'
  const written = await handleWriteLocalTextFile({ fileName: 'user-message-1042.txt', content }, SESSION_ID)
  assert.equal(written.success, true)

  const sent = []
  const exec = new LocalExecutor({
    ws: { sendReliable: async (payload) => { sent.push(payload); return true } },
    getToken: async () => null,
    baseUrl: 'https://mao.etarch.cn/api',
    workspace: ws,
    policy: policy(),
  })
  // 既有工具（read_file）：绝对路径直达，不受新增 case 影响
  await exec.handleEvent({
    type: 'tool_execute',
    sessionId: SESSION_ID,
    data: {
      requestId: 'r-read',
      toolName: 'read_file',
      arguments: JSON.stringify({ path: written.path }),
      workspace: ws,
      needApproval: false,
    },
  })
  await exec.close()

  const resultMsg = sent.find((m) => m.type === 'tool_result')
  assert.ok(resultMsg, 'read_file 应回 tool_result')
  assert.match(String(resultMsg.result), /14084181,14084183/)
  assert.equal(fs.existsSync(written.path), true)
  // dump 目录就在会话 runtime 内（shell workdir / 搜索根的沙箱允许根之一）
  assert.equal(path.relative(path.dirname(userMessagesDir(home)), path.dirname(written.path)), 'userMessages')
})


// ─────────────── C. 审批门禁 ───────────────

test('C1 硬门禁优先于 needApproval=false：未信任工作区一律拒绝', async () => {
  const { ws } = setupHome({ trusted: false })
  const { evaluateApproval } = cliApproval()
  const req = {
    toolName: 'write_local_text_file',
    args: { fileName: 'user-message-1.txt', content: 'rm -rf /' },
    workspace: ws,
    needApproval: false,
    dangerReason: null,
    description: 'user-message-1.txt',
  }
  const decision = evaluateApproval(req, policy())
  assert.equal(decision.action, 'deny')
  assert.match(String(decision.reason), /工作区未信任/)
})

test('C2 已信任 + needApproval=false → 放行；拒绝清单只看 command/input/path 类字段，不看 content', async () => {
  const { ws } = setupHome({ trusted: true })
  const { evaluateApproval } = cliApproval()
  const base = { workspace: ws, needApproval: false, dangerReason: null, description: 'user-message-1.txt' }

  // 内容里含危险命令片段：不参与 deny-list（dump 的原文本来就可能是这类文本），照常放行
  const dumpReq = { ...base, toolName: 'write_local_text_file', args: { fileName: 'user-message-1.txt', content: 'rm -rf / && mkfs.ext4' } }
  assert.equal(evaluateApproval(dumpReq, policy()).action, 'allow')

  // deny-list 仍然生效：exec 类字段命中即拒绝
  const execReq = { ...base, toolName: 'whatever', args: { input: 'rm -rf /' } }
  assert.equal(evaluateApproval(execReq, policy()).action, 'deny')

  // deny-list 命中敏感路径字段
  const pathReq = { ...base, toolName: 'write_file', args: { path: '~/.ssh/config', content: 'x' } }
  assert.equal(evaluateApproval(pathReq, policy()).action, 'deny')
})

test('C3 LocalExecutor 端到端：未信任工作区下 write_local_text_file 不落盘、回 tool_error', async () => {
  const { home, ws } = setupHome({ trusted: false })
  const { LocalExecutor } = require(path.join(CLI_DIST, 'local/executor.js'))
  const sent = []
  const exec = new LocalExecutor({
    ws: { sendReliable: async (payload) => { sent.push(payload); return true } },
    getToken: async () => null,
    baseUrl: 'https://mao.etarch.cn/api',
    workspace: ws,
    policy: policy(),
  })
  await exec.handleEvent({
    type: 'tool_execute',
    sessionId: SESSION_ID,
    data: {
      requestId: 'r-untrusted',
      toolName: 'write_local_text_file',
      arguments: JSON.stringify({ fileName: 'user-message-1.txt', content: 'x' }),
      workspace: ws,
      needApproval: false,
    },
  })
  await exec.close()

  assert.equal(sent.some((m) => m.type === 'tool_result'), false)
  const errFrame = sent.find((m) => m.type === 'tool_error')
  assert.ok(errFrame, '应回 tool_error')
  assert.match(String(errFrame.error), /工作区未信任/)
  assert.equal(fs.existsSync(userMessagesDir(home)), false)
})
