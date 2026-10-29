'use strict'
/**
 * 第 2 轮审查复现脚本（node --test）——复核第 1 轮两个问题的修复：
 *   A. 渲染层粘贴附件路径（main.cjs:1413-1416，dedupe=true）：同名写入追加 -1 / -2 副本，绝不覆盖已有附件引用；
 *      覆盖「组件重建」与「页面刷新（序号归零）」两种场景。
 *   B. dump_user_messages 路径（main.cjs:2405-2407，dedupe=false）：按消息 id 幂等覆盖，不产生副本；
 *      用真实 DumpUserMessagesTool（LOCAL）连跑两次验证端到端。
 *   C. 防回归：不传 dedupe 时默认按避重处理（避免将来漏传悄悄退回覆盖语义）。
 *
 * 运行（仓库根目录，需先 npm run build backend-ts，脚本读 backend-ts/dist）：
 *   node --test docs/code-review/repro/2026-10-29-long-user-message-file-export-round2/dedupe-semantics.test.cjs
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '../../../..')
const { writeLocalTextFileAsync } = require(path.join(REPO, 'desktop/electron/chatAttachment.cjs'))

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mao-r2-home-'))

/** 与 desktop/electron/main.cjs:2665 handleLocalWriteTextFile 逐字对齐（dedupe 由两个调用点决定）。 */
async function handleLocalWriteTextFile(args, sessionId, dedupe, homeDir) {
  const result = await writeLocalTextFileAsync({
    fileName: args?.fileName,
    content: args?.content,
    maxSizeMb: args?.maxSizeMb,
    sessionId,
    dedupe,
    homeDir,
    hostKey: 'host',
  })
  if (!result.ok) return { error: result.error }
  return { success: true, path: result.absolutePath, bytes_written: result.bytes }
}

/** 渲染层粘贴附件：IPC 'local-write-text-file' → dedupe=true（main.cjs:1415）。 */
const rendererWrite = (args, sessionId, homeDir) => handleLocalWriteTextFile(args, sessionId, true, homeDir)
/** Agent 工具委托：'write_local_text_file' → dedupe=false（main.cjs:2407）。 */
const toolWrite = (args, sessionId, homeDir) => handleLocalWriteTextFile(args, sessionId, false, homeDir)

test('A1. 渲染层同名粘贴附件两次写入：产生 -1 副本，第一份内容与引用不被改写', async () => {
  const homeDir = tempHome()
  const first = await rendererWrite({ fileName: 'pasted-text-1.txt', content: '第一批 14084181' }, 42, homeDir)
  const second = await rendererWrite({ fileName: 'pasted-text-1.txt', content: '第二批 14090001' }, 42, homeDir)

  assert.equal(first.success, true)
  assert.equal(second.success, true)
  assert.notEqual(second.path, first.path)
  assert.equal(first.path, path.join(homeDir, '.mao', 'attachments', 'host', '42', 'pasted-text-1.txt'))
  assert.equal(second.path, path.join(homeDir, '.mao', 'attachments', 'host', '42', 'pasted-text-1-1.txt'))
  // 第一条消息里的 @{...pasted-text-1.txt}@ 仍读到第一批内容
  assert.equal(fs.readFileSync(first.path, 'utf8'), '第一批 14084181')
  assert.equal(fs.readFileSync(second.path, 'utf8'), '第二批 14090001')
})

test('A2. 页面刷新（序号归零，再次出现 pasted-text-1.txt）：继续追加 -2，历史引用均不被改写', async () => {
  const homeDir = tempHome()
  const w1 = await rendererWrite({ fileName: 'pasted-text-1.txt', content: 'batch#1' }, 42, homeDir)
  const w2 = await rendererWrite({ fileName: 'pasted-text-1.txt', content: 'batch#2' }, 42, homeDir)
  const w3 = await rendererWrite({ fileName: 'pasted-text-1.txt', content: 'batch#3' }, 42, homeDir)

  assert.equal(new Set([w1.path, w2.path, w3.path]).size, 3)
  assert.deepEqual(
    fs.readdirSync(path.dirname(w1.path)).sort(),
    ['pasted-text-1-1.txt', 'pasted-text-1-2.txt', 'pasted-text-1.txt'],
  )
  assert.equal(fs.readFileSync(w1.path, 'utf8'), 'batch#1')
  assert.equal(fs.readFileSync(w2.path, 'utf8'), 'batch#2')
  assert.equal(fs.readFileSync(w3.path, 'utf8'), 'batch#3')
})

test('A3. 防回归：不传 dedupe 时默认避重（不覆盖）', async () => {
  const homeDir = tempHome()
  const params = { fileName: 'pasted-text-9.txt', content: 'x', sessionId: 7, homeDir, hostKey: 'host' }
  const first = await writeLocalTextFileAsync(params)
  const second = await writeLocalTextFileAsync({ ...params, content: 'y' })
  assert.notEqual(second.absolutePath, first.absolutePath)
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), 'x')
})

test('B1. dump 路径（dedupe=false）：同消息重复写入覆盖同文件，不产生副本', async () => {
  const homeDir = tempHome()
  const first = await toolWrite({ fileName: 'user-message-7.txt', content: 'v1' }, 42, homeDir)
  const second = await toolWrite({ fileName: 'user-message-7.txt', content: 'v2' }, 42, homeDir)

  assert.equal(first.success, true)
  assert.equal(second.success, true)
  assert.equal(second.path, first.path)
  assert.deepEqual(fs.readdirSync(path.dirname(first.path)), ['user-message-7.txt'])
  assert.equal(fs.readFileSync(first.path, 'utf8'), 'v2')
})

test('B2. 端到端：真实 DumpUserMessagesTool(LOCAL) 连跑两次 → 同路径、单文件、内容为最新', async () => {
  const { DumpUserMessagesTool } = await import(
    path.join(REPO, 'backend-ts/dist/harness/tool/impl/dump-user-messages-tool.js')
  )
  const { RuntimeDataResolver } = await import(
    path.join(REPO, 'backend-ts/dist/harness/runtime/runtime-data-resolver.js')
  )
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-r2-runtime-'))
  const homeDir = tempHome()
  let content = '14084181,14084183'
  const messages = [{ id: 1042, role: 'USER', content: 'placeholder' }]

  const tool = new DumpUserMessagesTool(
    {
      getRecentUserMessages: async (_sid, limit) => messages.slice(-limit).map((m) => ({ ...m, content })),
      extractVisibleText: (c) => c,
    },
    RuntimeDataResolver.forTest(runtimeDir, homeDir),
    {
      // 模拟 LocalToolExecutor + desktop tool-execute（走 dedupe=false）
      execute: async (sessionId, toolName, argsJson) => {
        assert.equal(toolName, 'write_local_text_file')
        return JSON.stringify(await toolWrite(JSON.parse(argsJson), sessionId, homeDir))
      },
    },
    { selectById: async () => ({ executionMode: 'LOCAL' }) },
  )

  const first = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), 9, 7, null))
  content = '14090001,14090002' // 用户编辑了这条消息后重新导出
  const second = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), 9, 7, null))

  assert.equal(second.files[0].path, first.files[0].path)
  const dir = path.join(homeDir, '.mao', 'attachments', 'host', '9')
  assert.deepEqual(fs.readdirSync(dir), ['user-message-1042.txt'])
  assert.equal(fs.readFileSync(first.files[0].path, 'utf8'), '14090001,14090002')
})
