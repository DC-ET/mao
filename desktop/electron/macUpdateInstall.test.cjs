'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const installer = require('./macUpdateInstall.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mao-mac-update-'))
}

test('从可执行文件定位 .app，磁盘映像和 App Translocation 不能就地替换', () => {
  assert.equal(
    installer.resolveMacAppBundle('/Applications/Mao.app/Contents/MacOS/Mao'),
    '/Applications/Mao.app',
  )
  assert.equal(installer.resolveMacAppBundle('/usr/local/bin/node'), null)
  assert.equal(
    installer.bundleInstallBlocker('/Volumes/Mao/Mao.app'),
    'disk-image',
  )
  assert.equal(
    installer.bundleInstallBlocker('/private/var/folders/ab/AppTranslocation/xyz/d/Mao.app'),
    'translocated',
  )
  assert.equal(installer.bundleInstallBlocker('/Applications/Mao.app'), null)
})

test('父目录不可写或 zip 不存在时拒绝替换', () => {
  const root = tempDir()
  const bundle = path.join(root, 'Mao.app')
  const exe = path.join(bundle, 'Contents', 'MacOS', 'Mao')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(exe, '')
  const zip = path.join(root, 'update.zip')
  const missing = installer.planMacInstall({ execPath: exe, zipPath: zip })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'missing-zip')

  fs.writeFileSync(zip, 'zip')
  // root 无视目录权限（容器/CI 常以 root 运行）：chmod 造不出「不可写」，
  // 该分支只在非 root 环境验证，避免把环境差异当回归。
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    fs.chmodSync(root, 0o555)
    try {
      const denied = installer.planMacInstall({ execPath: exe, zipPath: zip })
      assert.equal(denied.ok, false)
      assert.equal(denied.reason, 'not-writable')
    } finally {
      fs.chmodSync(root, 0o755)
    }
  }

  const ready = installer.planMacInstall({ execPath: exe, zipPath: zip })
  assert.equal(ready.ok, true)
  assert.equal(ready.bundlePath, installer.resolveMacAppBundle(exe))
})

test('安装脚本在进程退出后替换 .app，不校验签名', { skip: process.platform !== 'darwin' }, () => {
  const root = tempDir()
  const bundle = path.join(root, 'Mao.app')
  const oldMarker = path.join(bundle, 'Contents', 'MacOS', 'marker.txt')
  fs.mkdirSync(path.dirname(oldMarker), { recursive: true })
  fs.writeFileSync(oldMarker, 'old')

  const freshRoot = path.join(root, 'fresh')
  const freshApp = path.join(freshRoot, 'Mao.app')
  const newMarker = path.join(freshApp, 'Contents', 'MacOS', 'marker.txt')
  fs.mkdirSync(path.dirname(newMarker), { recursive: true })
  fs.writeFileSync(newMarker, 'new')
  const zip = path.join(root, 'update.zip')
  execFileSync('ditto', ['-c', '-k', '--keepParent', freshApp, zip])

  const script = path.join(root, 'install.sh')
  installer.writeInstallScript(script)
  const log = path.join(root, 'install.log')
  execFileSync('/bin/bash', [
    script,
    '2147483646',
    zip,
    bundle,
    log,
    'Mao.app',
    '5',
    '0',
  ])
  assert.equal(fs.readFileSync(oldMarker, 'utf8'), 'new')
  assert.match(fs.readFileSync(log, 'utf8'), /ok/)
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith('.Mao.update-backup.')),
    [],
  )
})
