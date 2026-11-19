#!/usr/bin/env node
// node-pty 是原生模块：electron-rebuild 重编译后，prebuilds/*/spawn-helper 可能落成
// 不可执行（0644）。require 与 typeof spawn 都正常，第一次 spawn 才 posix_spawnp failed。
// 这里在安装期补一次 x 位；运行时 terminalHost.cjs 的 ensurePtyHelpersExecutable 会幂等自愈。
'use strict'

const fs = require('fs')
const path = require('path')

function ptyRoot() {
  let root = path.dirname(require.resolve('node-pty/package.json'))
  for (let depth = 0; depth < 4; depth++) {
    if (fs.existsSync(path.join(root, 'prebuilds')) || fs.existsSync(path.join(root, 'build'))) break
    const parent = path.dirname(root)
    if (parent === root) return null
    root = parent
  }
  return root
}

const root = ptyRoot()
if (root == null) {
  console.warn('[fix-node-pty-perms] node-pty 未安装或结构异常，跳过')
  process.exit(0)
}

const helpers = [
  path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  path.join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'winpty-agent.exe'),
  path.join(root, 'build', 'Release', 'spawn-helper'),
]

let fixed = 0
for (const helper of helpers) {
  try {
    if (!fs.existsSync(helper)) continue
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) !== 0) continue
    fs.chmodSync(helper, (mode & 0o777) | 0o111)
    fixed++
    console.log(`[fix-node-pty-perms] chmod +x ${helper}`)
  } catch (e) {
    console.warn(`[fix-node-pty-perms] 跳过 ${helper}: ${e.message}`)
  }
}
if (fixed === 0) console.log('[fix-node-pty-perms] 无需修复')
