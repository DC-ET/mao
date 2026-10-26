'use strict'

/**
 * 审查候选（已排除）：chatAttachment.cjs 并发拷贝竞态（uniqueName 与 copyFileSync 的 TOCTOU）
 *
 * 假设：两次发送动作并发把「同名但不同内容」的文件拷入同一会话目录，
 *       uniqueName 的存在性检查与 copyFileSync 之间没有互斥，双方算出同一目标名，
 *       后完成者静默覆盖先完成者——两条消息引用同一路径，其中一条内容错误。
 *
 * 结论：不成立。copyLocalAttachment 是【完全同步】函数（内部 lstatSync/existsSync/
 *       mkdirSync/copyFileSync，无任何 await），且 IPC handler 直接同步 return 其结果。
 *       单实例锁又保证同一时刻只有一个桌面进程，因此两次拷贝不可能交错执行。
 *       本文件保留一条用例作为「已排查」的记录：证明函数同步返回（非 Promise），
 *       并发 Promise.all 对其只是串行调用，无交错窗口；并顺带验证串行重名的 -1 后缀。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// 本文件位于 <repo>/docs/code-review/repro/2026-10-26-electron-shell/，向上 4 层即仓库根。
const CHAT_ATTACHMENT_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'desktop', 'electron', 'chatAttachment.cjs')
const { copyLocalAttachment } = require(CHAT_ATTACHMENT_PATH)

function tempHome(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-attach-race-')))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return home
}

test('copyLocalAttachment 同步返回（非 Promise）→ 并发调用实为串行，不存在交错窗口', (t) => {
  const home = tempHome(t)
  const dirA = path.join(home, 'srcA')
  const dirB = path.join(home, 'srcB')
  fs.mkdirSync(dirA)
  fs.mkdirSync(dirB)
  const srcA = path.join(dirA, 'report.pdf')
  const srcB = path.join(dirB, 'report.pdf')
  fs.writeFileSync(srcA, 'CONTENT-FROM-A')
  fs.writeFileSync(srcB, 'CONTENT-FROM-B')

  const r1 = copyLocalAttachment({ sourcePath: srcA, sessionId: 5, maxSizeMb: 10, homeDir: home, hostKey: 'host' })
  // 关键：同步函数直接返回结果对象；Promise.all([r1, r2]) 也只是对两个已求值结果建 Promise
  assert.equal(typeof r1.then, 'undefined', 'copyLocalAttachment 不应返回 Promise（同步函数）')
  assert.equal(r1.ok, true, JSON.stringify(r1))

  const r2 = copyLocalAttachment({ sourcePath: srcB, sessionId: 5, maxSizeMb: 10, homeDir: home, hostKey: 'host' })
  assert.equal(r2.ok, true, JSON.stringify(r2))

  // 串行语义下重名正确追加后缀，两个引用路径不同、内容各自与来源一致
  assert.notEqual(r1.absolutePath, r2.absolutePath)
  assert.equal(path.basename(r1.absolutePath), 'report.pdf')
  assert.equal(path.basename(r2.absolutePath), 'report-1.pdf')
  assert.equal(fs.readFileSync(r1.absolutePath, 'utf8'), 'CONTENT-FROM-A')
  assert.equal(fs.readFileSync(r2.absolutePath, 'utf8'), 'CONTENT-FROM-B')
})
