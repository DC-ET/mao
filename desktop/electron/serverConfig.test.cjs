'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  DEFAULT_SERVER_BASE_URL,
  normalizeServerBaseUrl,
  deriveApiBase,
  deriveUpdateFeedUrl,
  serverHostKey,
  readServerConfig,
  writeServerConfig,
  resolveUpdateFeedUrl,
  probeServer,
  defaultServerConfig,
} = require('./serverConfig.cjs')

function tempUserData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-server-config-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('normalizeServerBaseUrl accepts site root, /api and /api/v1', () => {
  const cases = [
    ['https://mao.example.com', 'https://mao.example.com'],
    ['https://mao.example.com/', 'https://mao.example.com'],
    ['https://mao.example.com/api', 'https://mao.example.com'],
    ['https://mao.example.com/api/v1', 'https://mao.example.com'],
    ['https://mao.example.com/api/v1/', 'https://mao.example.com'],
    ['mao.example.com', 'https://mao.example.com'],
    ['https://mao.example.com:8443/api/v1', 'https://mao.example.com:8443'],
  ]
  for (const [input, expected] of cases) {
    const result = normalizeServerBaseUrl(input, { allowHttp: true })
    assert.equal(result.ok, true, input)
    assert.equal(result.baseUrl, expected, input)
  }
})

test('normalizeServerBaseUrl rejects invalid or insecure input by default', () => {
  assert.equal(normalizeServerBaseUrl('').ok, false)
  assert.equal(normalizeServerBaseUrl('http://mao.example.com').ok, false)
  assert.equal(normalizeServerBaseUrl('ftp://mao.example.com').ok, false)
  assert.equal(normalizeServerBaseUrl('https://user:pass@mao.example.com').ok, false)
  const httpAllowed = normalizeServerBaseUrl('http://10.0.0.8:9080', { allowHttp: true })
  assert.equal(httpAllowed.ok, true)
  assert.equal(httpAllowed.baseUrl, 'http://10.0.0.8:9080')
})

test('derive helpers and host key', () => {
  assert.equal(deriveApiBase('https://mao.example.com'), 'https://mao.example.com/api')
  assert.equal(
    deriveUpdateFeedUrl('https://mao.example.com'),
    'https://mao.example.com/api/uploads/releases/'
  )
  assert.equal(serverHostKey('https://mao.example.com'), 'mao.example.com')
  assert.equal(serverHostKey('https://10.0.0.8:9080'), '10.0.0.8_9080')
})

test('readServerConfig returns defaults when file missing', (t) => {
  const dir = tempUserData(t)
  const { config, fromFile } = readServerConfig(dir)
  assert.equal(fromFile, false)
  assert.equal(config.serverBaseUrl, DEFAULT_SERVER_BASE_URL)
  assert.equal(config.configured, false)
  assert.equal(config.updateFeedMode, 'follow-site')
})

test('writeServerConfig persists normalized baseUrl', (t) => {
  const dir = tempUserData(t)
  const result = writeServerConfig(dir, {
    serverBaseUrl: 'https://mao.example.com/api/v1',
    updateFeedMode: 'follow-site',
  })
  assert.equal(result.ok, true)
  assert.equal(result.config.serverBaseUrl, 'https://mao.example.com')
  const reread = readServerConfig(dir)
  assert.equal(reread.fromFile, true)
  assert.equal(reread.config.serverBaseUrl, 'https://mao.example.com')
  assert.equal(reread.config.configured, true)
})

test('writeServerConfig rejects invalid url', (t) => {
  const dir = tempUserData(t)
  const result = writeServerConfig(dir, { serverBaseUrl: 'ftp://bad' })
  assert.equal(result.ok, false)
  assert.match(result.error, /协议|无效|地址/)
})

test('resolveUpdateFeedUrl modes', () => {
  const base = { serverBaseUrl: 'https://mao.example.com', updateFeedMode: 'follow-site' }
  assert.deepEqual(resolveUpdateFeedUrl(base, ''), {
    mode: 'follow-site',
    url: 'https://mao.example.com/api/uploads/releases/',
  })
  assert.deepEqual(resolveUpdateFeedUrl({ ...base, updateFeedMode: 'disabled' }, ''), {
    mode: 'disabled',
    url: null,
  })
  assert.deepEqual(resolveUpdateFeedUrl({ ...base, updateFeedMode: 'package-default' }, ''), {
    mode: 'package-default',
    url: null,
  })
  assert.deepEqual(resolveUpdateFeedUrl(base, 'https://cdn.example.com/releases/'), {
    mode: 'env-override',
    url: 'https://cdn.example.com/releases/',
  })
})

test('probeServer accepts version.json payload', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/version.json')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ version: '0.0.163', buildTime: 'x' }),
      }
    }
    return { ok: false, status: 404, text: async () => '' }
  }
  const result = await probeServer('https://mao.example.com', { fetchImpl })
  assert.equal(result.ok, true)
  assert.match(result.detail, /0\.0\.163/)
})

test('probeServer flags non-Mao root html', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/version.json')) {
      return { ok: false, status: 404, text: async () => 'nope' }
    }
    return {
      ok: true,
      status: 200,
      text: async () => '<html><title>Other App</title></html>',
    }
  }
  const result = await probeServer('https://other.example.com', { fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.error, /不是 Mao/)
})

test('defaultServerConfig shape', () => {
  const config = defaultServerConfig()
  assert.equal(config.version, 1)
  assert.equal(config.configured, false)
})
