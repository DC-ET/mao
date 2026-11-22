'use strict'

/** 录制开关取值回归（技术方案 2026-11-22 §3.1）：缓存 / token 失效 / 失败兜底。 */

const test = require('node:test')
const assert = require('node:assert')
const { createBrowserLiveRecordFlag } = require('./browserLiveRecordFlag.cjs')

function make({ token = 'tok-1', base = 'http://h/api', respond, now = (() => 1_000_000), readAuth } = {}) {
  const calls = []
  const flag = createBrowserLiveRecordFlag({
    getApiBaseUrl: () => base,
    readAuth: readAuth ?? (() => ({ token })),
    fetchImpl: respond ? async (url, init) => { calls.push({ url, init }); return respond(url, init) } : undefined,
    now,
  })
  return { flag, calls }
}

test('开启：拉取 readiness 并缓存，TTL 内不再发请求', async () => {
  let clock = 1_000_000
  const { flag, calls } = make({
    now: () => clock,
    respond: () => ({ json: async () => ({ code: 0, data: { browserLiveRecordEnabled: true } }) }),
  })
  assert.equal(await flag.get(), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://h/api/v1/readiness')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1')
  clock += 60_000
  assert.equal(await flag.get(), true)
  assert.equal(calls.length, 1) // TTL 内复用
  clock += 6 * 60_000
  await flag.get()
  assert.equal(calls.length, 2) // TTL 过期重新拉取
})

test('关闭：code=0 且 flag 非 true 视为关闭', async () => {
  const { flag } = make({ respond: () => ({ json: async () => ({ code: 0, data: {} }) }) })
  assert.equal(await flag.get(), false)
})

test('拉取失败：保留上次取值并 ~30s 后才重试', async () => {
  let clock = 1_000_000
  const { flag, calls } = make({
    now: () => clock,
    respond: () => { throw new Error('net down') },
  })
  assert.equal(await flag.get(), false)
  clock += 1_000
  assert.equal(await flag.get(), false)
  assert.equal(calls.length, 1) // 失败后 30s 内不重试
  clock += 31_000
  await flag.get()
  assert.equal(calls.length, 2)
})

test('token 变化即失效；未登录恒为关闭', async () => {
  let current = 'tok-1'
  const { flag, calls } = make({
    readAuth: () => ({ token: current }),
    respond: () => ({ json: async () => ({ code: 0, data: { browserLiveRecordEnabled: true } }) }),
  })
  assert.equal(await flag.get(), true)
  assert.equal(calls.length, 1)
  current = 'tok-2'
  assert.equal(await flag.get(), true)
  assert.equal(calls.length, 2) // token 变了重新拉

  const anon = make({ token: null, respond: () => ({ json: async () => ({ code: 0, data: { browserLiveRecordEnabled: true } }) }) })
  assert.equal(await anon.flag.get(), false)
  assert.equal(anon.calls.length, 0)
})

test('invalidate 清缓存', async () => {
  const { flag, calls } = make({ respond: () => ({ json: async () => ({ code: 0, data: { browserLiveRecordEnabled: true } }) }) })
  await flag.get()
  flag.invalidate()
  await flag.get()
  assert.equal(calls.length, 2)
})
