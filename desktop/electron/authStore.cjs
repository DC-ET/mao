'use strict'

/**
 * 桌面壳登录态：userData/auth.json，按服务器 host 分槽。
 * 纯逻辑，可单测，不依赖 Electron。
 *
 * 切换服务器只改当前槽的读取位置，不删除其他槽。
 * 主动退出、401、从历史删除且没有其他地址指向同一 host 时，只清该槽。
 *
 * 旧格式 { token, refreshToken, serverHost } 在读取时并入对应槽；
 * 没有 serverHost 的旧票无法判断归属，丢弃，避免串站。
 */

const fs = require('fs')
const path = require('path')

const AUTH_VERSION = 2
const HOST_KEY_RE = /^[A-Za-z0-9._:-]{1,253}$/
const RESERVED_HOST_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isHostKey(host) {
  return typeof host === 'string' && HOST_KEY_RE.test(host) && !RESERVED_HOST_KEYS.has(host)
}

function getAuthStorePath(userDataDir) {
  return path.join(String(userDataDir || ''), 'auth.json')
}

function asToken(value) {
  return typeof value === 'string' && value ? value : null
}

function blankStore() {
  return { version: AUTH_VERSION, sessions: Object.create(null) }
}

function putSlot(sessions, host, token, refreshToken) {
  if (!isHostKey(host)) return
  const nextToken = asToken(token)
  const nextRefresh = asToken(refreshToken)
  if (!nextToken && !nextRefresh) return
  if (sessions[host]) return
  sessions[host] = { token: nextToken, refreshToken: nextRefresh }
}

/**
 * @param {unknown} data
 * @returns {{ version: number, sessions: Record<string, { token: string | null, refreshToken: string | null }> }}
 */
function normalizeAuthStore(data) {
  const sessions = Object.create(null)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { version: AUTH_VERSION, sessions }
  }
  const record = /** @type {Record<string, unknown>} */ (data)
  const rawSessions = record.sessions
  if (rawSessions && typeof rawSessions === 'object' && !Array.isArray(rawSessions)) {
    for (const [host, slot] of Object.entries(rawSessions)) {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot)) continue
      const entry = /** @type {Record<string, unknown>} */ (slot)
      putSlot(sessions, host, entry.token, entry.refreshToken)
    }
  }
  putSlot(sessions, record.serverHost, record.token, record.refreshToken)
  return { version: AUTH_VERSION, sessions }
}

function readAuthFile(userDataDir) {
  const authPath = getAuthStorePath(userDataDir)
  try {
    if (!fs.existsSync(authPath)) return blankStore()
    return normalizeAuthStore(JSON.parse(fs.readFileSync(authPath, 'utf8')))
  } catch {
    return blankStore()
  }
}

function writeAuthFile(userDataDir, store) {
  const authPath = getAuthStorePath(userDataDir)
  fs.mkdirSync(path.dirname(authPath), { recursive: true })
  const sessions = {}
  for (const [host, slot] of Object.entries(store.sessions || {})) {
    if (!isHostKey(host) || !slot) continue
    const token = asToken(slot.token)
    const refreshToken = asToken(slot.refreshToken)
    if (!token && !refreshToken) continue
    sessions[host] = { token, refreshToken }
  }
  const payload = { version: AUTH_VERSION, sessions }
  fs.writeFileSync(authPath, JSON.stringify(payload), 'utf8')
  return payload
}

function readAuthTokens(userDataDir, hostKey) {
  if (!isHostKey(hostKey)) return { token: null, refreshToken: null }
  const slot = readAuthFile(userDataDir).sessions[hostKey]
  if (!slot) return { token: null, refreshToken: null }
  return { token: slot.token || null, refreshToken: slot.refreshToken || null }
}

function writeAuthTokens(userDataDir, hostKey, data) {
  if (!isHostKey(hostKey)) return false
  const store = readAuthFile(userDataDir)
  const token = asToken(data?.token)
  const refreshToken = asToken(data?.refreshToken)
  if (!token && !refreshToken) {
    delete store.sessions[hostKey]
  } else {
    store.sessions[hostKey] = { token, refreshToken }
  }
  writeAuthFile(userDataDir, store)
  return true
}

function clearAuthTokens(userDataDir, hostKey) {
  if (!isHostKey(hostKey)) return false
  const store = readAuthFile(userDataDir)
  if (!store.sessions[hostKey]) return false
  delete store.sessions[hostKey]
  writeAuthFile(userDataDir, store)
  return true
}

/** 当前站或历史里仍有同一 host 时，不能因为删掉其中一条地址就清登录。 */
function shouldForgetAuthHost(hostKey, currentHostKey, remainingHostKeys) {
  if (!isHostKey(hostKey)) return false
  if (hostKey === currentHostKey) return false
  return !(Array.isArray(remainingHostKeys) && remainingHostKeys.includes(hostKey))
}

module.exports = {
  AUTH_VERSION,
  isHostKey,
  getAuthStorePath,
  normalizeAuthStore,
  readAuthTokens,
  writeAuthTokens,
  clearAuthTokens,
  shouldForgetAuthHost,
}
