'use strict'
/**
 * 第 1 轮审查复现脚本（node --test）——「LOCAL 粘贴附件同名覆盖」：
 *   1) 服务端 dump_user_messages（LOCAL 分支）↔ 桌面端 chatAttachment.writeLocalTextFileAsync 的契约核对；
 *   2) 同名写入的历史行为（第 1 轮问题 1）。
 *
 * 第 2 轮变更说明：`writeLocalTextFileAsync` 已新增 `dedupe` 参数（缺省 true = 同名避重，
 * 渲染层粘贴附件语义）；`dedupe: false`（dump_user_messages 委托路径，main.cjs:2407）
 * 仍是覆盖语义。因此本脚本第 2 例显式传 `dedupe: false`，用于固化「按消息 id 幂等覆盖」，
 * 渲染层避重语义见 ../2026-10-29-long-user-message-file-export-round2/dedupe-semantics.test.cjs。
 *
 * 运行（仓库根目录）：
 *   node --test docs/code-review/repro/2026-10-29-long-user-message-file-export/overwrite-and-local-chain.test.cjs
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '../../../..')
const { writeLocalTextFileAsync } = require(path.join(REPO, 'desktop/electron/chatAttachment.cjs'))

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mao-review-home-'))
}

/** 与 desktop/electron/main.cjs:2660 handleLocalWriteTextFile 逐字对齐。 */
async function handleLocalWriteTextFile(args, sessionId, homeDir) {
  const result = await writeLocalTextFileAsync({
    fileName: args?.fileName,
    content: args?.content,
    maxSizeMb: args?.maxSizeMb,
    sessionId,
    homeDir,
    hostKey: 'host',
  })
  if (!result.ok) return { error: result.error }
  return { success: true, path: result.absolutePath, bytes_written: result.bytes }
}

test('契约：dump_user_messages(LOCAL) 委托 write_local_text_file，返回桌面端本机绝对路径', async () => {
  const { DumpUserMessagesTool } = await import(
    path.join(REPO, 'backend-ts/dist/harness/tool/impl/dump-user-messages-tool.js')
  )
  const { RuntimeDataResolver } = await import(
    path.join(REPO, 'backend-ts/dist/harness/runtime/runtime-data-resolver.js')
  )
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-review-runtime-'))
  const homeDir = tempHome()
  const messages = [{ id: 1042, role: 'USER', content: '14084181,14084183' }]

  const tool = new DumpUserMessagesTool(
    {
      getRecentUserMessages: async (_sid, limit) => messages.slice(-limit),
      extractVisibleText: (c) => c,
    },
    RuntimeDataResolver.forTest(runtimeDir, homeDir),
    // 模拟 LocalToolExecutor + desktop tool-execute（JSON.stringify 回包）
    {
      execute: async (sessionId, toolName, argsJson) => {
        assert.equal(toolName, 'write_local_text_file')
        return JSON.stringify(await handleLocalWriteTextFile(JSON.parse(argsJson), sessionId, homeDir))
      },
    },
    { selectById: async () => ({ executionMode: 'LOCAL' }) },
  )

  const out = JSON.parse(await tool.execute(JSON.stringify({ recentCount: 1 }), 9, 7, null))
  assert.equal(out.count, 1)
  assert.equal(out.files[0].path, path.join(homeDir, '.mao', 'attachments', 'host', '9', 'user-message-1042.txt'))
  assert.equal(fs.readFileSync(out.files[0].path, 'utf8'), '14084181,14084183')
})

test('同名粘贴附件在 dedupe=false（dump 委托语义）下第二次落盘覆盖第一次：历史消息引用被改写', async () => {
  const homeDir = tempHome()
  const first = await writeLocalTextFileAsync({
    fileName: 'pasted-text-1.txt', content: '第一批 ID: 14084181,14084183', sessionId: 42, homeDir, hostKey: 'host', dedupe: false,
  })
  const second = await writeLocalTextFileAsync({
    fileName: 'pasted-text-1.txt', content: '第二批 ID: 14090001,14090002', sessionId: 42, homeDir, hostKey: 'host', dedupe: false,
  })

  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  // 同一会话目录、同一文件名 → 同一路径（无重名规避，与 user-message-{id} 的幂等覆盖共用一套语义）
  assert.equal(second.absolutePath, first.absolutePath)
  assert.deepEqual(fs.readdirSync(path.dirname(first.absolutePath)), ['pasted-text-1.txt'])
  // 第一条消息里的 @{...}@ 引用现在读到的是第二批内容
  assert.equal(fs.readFileSync(first.absolutePath, 'utf8'), '第二批 ID: 14090001,14090002')
})
