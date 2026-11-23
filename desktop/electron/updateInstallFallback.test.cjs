'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const fallback = require('./updateInstallFallback.cjs')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mao-update-fallback-'))
}

test('安装成功后的版本不再提示', () => {
  assert.equal(fallback.classifyLaunchAttempt({
    fromVersion: '0.0.528',
    toVersion: '0.0.530',
    prompted: false,
  }, '0.0.530'), 'success')
  assert.equal(fallback.classifyLaunchAttempt({
    fromVersion: '0.0.528',
    toVersion: '0.0.530',
    prompted: false,
  }, '0.0.531'), 'success')
})

test('仍是旧版本且没提示过时要提示；提示过后不再重复', () => {
  const attempt = { fromVersion: '0.0.528', toVersion: '0.0.530', prompted: false }
  assert.equal(fallback.classifyLaunchAttempt(attempt, '0.0.528'), 'prompt')
  assert.equal(fallback.classifyLaunchAttempt({ ...attempt, prompted: true }, '0.0.528'), 'ignore')
  assert.equal(fallback.classifyLaunchAttempt(null, '0.0.528'), 'ignore')
  assert.equal(fallback.classifyLaunchAttempt({}, '0.0.528'), 'ignore')
})

test('按架构挑选手动安装的 dmg，并拼到更新源上', () => {
  const files = [
    { url: 'Mao-0.0.530-arm64-mac.zip', arch: 'arm64' },
    { url: 'Mao-0.0.530-arm64.dmg', arch: 'arm64' },
    { url: 'Mao-0.0.530-intel-mac.zip', arch: 'x64' },
    { url: 'Mao-0.0.530-intel.dmg', arch: 'x64' },
  ]
  const feed = 'https://mao.example.com/api/uploads/releases/'
  assert.equal(
    fallback.resolveManualDmgUrl(feed, fallback.pickManualDmg(files, 'arm64')),
    'https://mao.example.com/api/uploads/releases/Mao-0.0.530-arm64.dmg',
  )
  assert.equal(
    fallback.resolveManualDmgUrl(feed, fallback.pickManualDmg(files, 'x64')),
    'https://mao.example.com/api/uploads/releases/Mao-0.0.530-intel.dmg',
  )
})

test('没有 arch 字段时，Intel 包避开 arm64 文件名', () => {
  const files = [
    { url: 'Mao-0.0.530-arm64.dmg' },
    { url: 'Mao-0.0.530.dmg' },
  ]
  assert.equal(fallback.pickManualDmg(files, 'arm64'), 'Mao-0.0.530-arm64.dmg')
  assert.equal(fallback.pickManualDmg(files, 'x64'), 'Mao-0.0.530.dmg')
  assert.equal(fallback.resolveManualDmgUrl('', 'https://cdn.example/Mao.dmg'), 'https://cdn.example/Mao.dmg')
  assert.equal(fallback.resolveManualDmgUrl('', 'Mao.dmg'), null)
})

test('安装尝试写入后可标记已提示并清除', () => {
  const dir = tempDir()
  const info = fallback.snapshotUpdateInfo({
    version: '0.0.530',
    files: [{ url: 'Mao-0.0.530-arm64.dmg', arch: 'arm64' }, { url: '' }, null],
  })
  fallback.writeInstallAttempt(dir, {
    fromVersion: '0.0.528',
    toVersion: info.version,
    files: info.files,
    prompted: false,
  })
  assert.equal(fallback.readInstallAttempt(dir).toVersion, '0.0.530')
  assert.equal(fallback.markInstallAttemptPrompted(dir).prompted, true)
  fallback.clearInstallAttempt(dir)
  assert.equal(fallback.readInstallAttempt(dir), null)
  assert.equal(fallback.markInstallAttemptPrompted(dir), null)
})
