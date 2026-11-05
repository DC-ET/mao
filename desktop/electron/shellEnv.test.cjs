'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveShellMaoBaseUrl } = require('./shellEnv.cjs')

test('returns the configured server base url', () => {
  assert.equal(
    resolveShellMaoBaseUrl({ configured: true, serverBaseUrl: 'https://mao.example.com' }),
    'https://mao.example.com'
  )
})

test('trims surrounding whitespace', () => {
  assert.equal(
    resolveShellMaoBaseUrl({ configured: true, serverBaseUrl: '  https://mao.example.com  ' }),
    'https://mao.example.com'
  )
})

test('returns null when the desktop server is not configured yet', () => {
  assert.equal(
    resolveShellMaoBaseUrl({ configured: false, serverBaseUrl: 'https://mao.example.com' }),
    null
  )
})

test('returns null when the server base url is blank or missing', () => {
  assert.equal(resolveShellMaoBaseUrl({ configured: true, serverBaseUrl: '' }), null)
  assert.equal(resolveShellMaoBaseUrl({ configured: true, serverBaseUrl: '   ' }), null)
  assert.equal(resolveShellMaoBaseUrl({ configured: true }), null)
  assert.equal(resolveShellMaoBaseUrl({}), null)
})
