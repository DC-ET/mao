'use strict'

const MAX_RETRIES = 3

function errorMessage(error) {
  if (!error) return ''
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function isRetryableUpdateError(error) {
  return /checksum mismatch|ERR_CHECKSUM_MISMATCH|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENOTFOUND|socket hang up|net::ERR_/i
    .test(errorMessage(error))
}

function retryDelayMs(attempt) {
  const override = Number(process.env.MAO_UPDATE_DOWNLOAD_RETRY_MS)
  if (Number.isFinite(override) && override >= 0) return override
  const step = Math.max(1, Number(attempt) || 1)
  return Math.min(15000, 2000 * (2 ** (step - 1)))
}

function canRetryUpdateDownload(error, attemptsAlreadyUsed) {
  const used = Number(attemptsAlreadyUsed) || 0
  return used < MAX_RETRIES && isRetryableUpdateError(error)
}

module.exports = {
  MAX_RETRIES,
  isRetryableUpdateError,
  retryDelayMs,
  canRetryUpdateDownload,
}
