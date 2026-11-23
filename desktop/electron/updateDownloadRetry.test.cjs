'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const retry = require('./updateDownloadRetry.cjs')

test('sha512 不一致和网络中断可以重试，次数有上限', () => {
  const checksum = new Error('sha512 checksum mismatch, expected abc, got def')
  assert.equal(retry.canRetryUpdateDownload(checksum, 0), true)
  assert.equal(retry.canRetryUpdateDownload(checksum, 2), true)
  assert.equal(retry.canRetryUpdateDownload(checksum, 3), false)
  assert.equal(retry.canRetryUpdateDownload(new Error('socket hang up'), 0), true)
  assert.equal(retry.canRetryUpdateDownload(new Error('Auto update is disabled'), 0), false)
})

test('默认重试间隔递增，测试可用环境变量覆盖', () => {
  const previous = process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS
  delete process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS
  try {
    assert.equal(retry.retryDelayMs(1), 2000)
    assert.equal(retry.retryDelayMs(2), 4000)
    assert.equal(retry.retryDelayMs(3), 8000)
    process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS = '20'
    assert.equal(retry.retryDelayMs(3), 20)
  } finally {
    if (previous == null) delete process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS
    else process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS = previous
  }
})
