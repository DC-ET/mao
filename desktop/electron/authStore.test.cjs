'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  getAuthStorePath,
  readAuthTokens,
  writeAuthTokens,
  clearAuthTokens,
  shouldForgetAuthHost,
  isHostKey,
} = require('./authStore.cjs')

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-auth-store-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('旧版单槽 auth.json 按 serverHost 迁入，其他 host 读不到', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(getAuthStorePath(dir), JSON.stringify({
    token: 'access-a',
    refreshToken: 'refresh-a',
    serverHost: 'mao.acg.team',
  }))

  assert.deepEqual(readAuthTokens(dir, 'mao.acg.team'), {
    token: 'access-a',
    refreshToken: 'refresh-a',
  })
  assert.deepEqual(readAuthTokens(dir, 'mao.etarch.cn'), {
    token: null,
    refreshToken: null,
  })
})

test('没有 serverHost 的旧票不归到任何站', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(getAuthStorePath(dir), JSON.stringify({
    token: 'orphan',
    refreshToken: 'orphan-r',
  }))

  assert.equal(readAuthTokens(dir, 'mao.acg.team').token, null)
  writeAuthTokens(dir, 'mao.etarch.cn', { token: 'b', refreshToken: 'rb' })
  const disk = JSON.parse(fs.readFileSync(getAuthStorePath(dir), 'utf8'))
  assert.equal(disk.version, 2)
  assert.equal(disk.sessions['mao.acg.team'], undefined)
  assert.equal(disk.sessions['mao.etarch.cn'].token, 'b')
  assert.equal(disk.token, undefined)
})

test('写入一台服务器不覆盖另一台，清空只删当前槽', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(getAuthStorePath(dir), JSON.stringify({
    token: 'access-a',
    refreshToken: 'refresh-a',
    serverHost: 'mao.acg.team',
  }))

  assert.equal(writeAuthTokens(dir, 'mao.etarch.cn', { token: 'access-b', refreshToken: 'refresh-b' }), true)
  assert.equal(readAuthTokens(dir, 'mao.acg.team').token, 'access-a')
  assert.equal(readAuthTokens(dir, 'mao.etarch.cn').refreshToken, 'refresh-b')

  assert.equal(clearAuthTokens(dir, 'mao.acg.team'), true)
  assert.equal(clearAuthTokens(dir, 'mao.acg.team'), false)
  assert.equal(readAuthTokens(dir, 'mao.acg.team').token, null)
  assert.equal(readAuthTokens(dir, 'mao.etarch.cn').token, 'access-b')

  const disk = JSON.parse(fs.readFileSync(getAuthStorePath(dir), 'utf8'))
  assert.equal(disk.sessions['mao.acg.team'], undefined)
})

test('坏文件与非法 host 不写入', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(getAuthStorePath(dir), '{')
  assert.equal(readAuthTokens(dir, 'mao.acg.team').token, null)
  assert.equal(isHostKey('__proto__'), false)
  assert.equal(isHostKey('constructor'), false)
  assert.equal(writeAuthTokens(dir, '__proto__', { token: 'x', refreshToken: 'y' }), false)
  assert.equal(writeAuthTokens(dir, '', { token: 'x', refreshToken: 'y' }), false)
})

test('删除历史时，当前站或仍被其他地址占用的 host 保留登录', () => {
  assert.equal(shouldForgetAuthHost('mao.etarch.cn', 'mao.acg.team', []), true)
  assert.equal(shouldForgetAuthHost('mao.acg.team', 'mao.acg.team', []), false)
  assert.equal(shouldForgetAuthHost('mao.etarch.cn', 'mao.acg.team', ['mao.etarch.cn']), false)
  assert.equal(shouldForgetAuthHost('constructor', 'mao.acg.team', []), false)
})
