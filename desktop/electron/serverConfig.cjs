'use strict'

/**
 * 桌面壳「多服务器 baseUrl」配置：纯逻辑，可单测，不依赖 Electron。
 * 约定：配置项为站点根（无尾斜杠），API/更新源由此推导。
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_SERVER_BASE_URL = 'https://mao.etarch.cn'
const CONFIG_VERSION = 1
const UPDATE_MODES = ['follow-site', 'package-default', 'disabled']

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '')
}

/**
 * 归一化用户输入为站点根。
 * 接受：站点根 / /api / /api/v1；无协议时默认 https。
 * @param {string} input
 * @param {{ allowHttp?: boolean }} [options]
 * @returns {{ ok: true, baseUrl: string } | { ok: false, error: string }}
 */
function normalizeServerBaseUrl(input, options = {}) {
  const allowHttp = options.allowHttp === true
  const raw = String(input || '').trim()
  if (!raw) return { ok: false, error: '请填写服务器地址' }

  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`
  }

  let parsed
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, error: '服务器地址格式无效' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: '服务器地址不能包含账号密码' }
  }
  if (parsed.protocol === 'https:') {
    // ok
  } else if (parsed.protocol === 'http:') {
    if (!allowHttp) {
      return { ok: false, error: '默认仅支持 HTTPS；内网 HTTP 请确认后开启允许' }
    }
  } else {
    return { ok: false, error: `不支持的协议：${parsed.protocol}` }
  }
  if (!parsed.hostname) {
    return { ok: false, error: '服务器地址缺少主机名' }
  }

  // 剥掉 /api、/api/v1 等路径后缀，只保留站点根（保留显式非标准端口）
  let pathname = parsed.pathname || '/'
  pathname = pathname.replace(/\/+$/, '')
  if (/\/api\/v1$/i.test(pathname)) {
    pathname = pathname.replace(/\/api\/v1$/i, '')
  } else if (/\/api$/i.test(pathname)) {
    pathname = pathname.replace(/\/api$/i, '')
  }
  if (pathname && pathname !== '/' && !/^\/[^/]/.test(pathname)) {
    pathname = ''
  }
  // 允许部署在子路径的站点：仅当 path 不是 api 后缀时保留
  if (/\/api(\/v1)?$/i.test(pathname)) {
    pathname = pathname.replace(/\/api(\/v1)?$/i, '')
  }

  const origin = parsed.origin
  const suffix = pathname === '/' ? '' : pathname
  const baseUrl = stripTrailingSlash(`${origin}${suffix}`)
  return { ok: true, baseUrl }
}

/** 由站点根推导 API 根（无 /v1）：{origin}/api */
function deriveApiBase(baseUrl) {
  const normalized = typeof baseUrl === 'string' && baseUrl ? baseUrl : DEFAULT_SERVER_BASE_URL
  return `${stripTrailingSlash(normalized)}/api`
}

/** 由站点根推导默认更新源 */
function deriveUpdateFeedUrl(baseUrl) {
  return `${deriveApiBase(baseUrl)}/uploads/releases/`
}

/** LOCAL runtime 目录命名空间：host 或 host_port */
function serverHostKey(baseUrl) {
  try {
    const url = new URL(String(baseUrl || DEFAULT_SERVER_BASE_URL))
    const host = url.hostname || 'default'
    return url.port ? `${host}_${url.port}` : host
  } catch {
    return 'default'
  }
}

function getConfigVersion() {
  return CONFIG_VERSION
}

function getServerConfigPath(userDataDir) {
  return path.join(String(userDataDir || ''), 'server-config.json')
}

function defaultServerConfig() {
  return {
    version: CONFIG_VERSION,
    serverBaseUrl: DEFAULT_SERVER_BASE_URL,
    updateFeedMode: 'follow-site',
    allowHttp: false,
    configured: false,
    updatedAt: null,
  }
}

/**
 * @param {string} userDataDir
 * @returns {{ config: ReturnType<typeof defaultServerConfig>, fromFile: boolean }}
 */
function readServerConfig(userDataDir) {
  const defaults = defaultServerConfig()
  const filePath = getServerConfigPath(userDataDir)
  try {
    if (!fs.existsSync(filePath)) return { config: defaults, fromFile: false }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const updateFeedMode = UPDATE_MODES.includes(data?.updateFeedMode)
      ? data.updateFeedMode
      : defaults.updateFeedMode
    const normalized = normalizeServerBaseUrl(data?.serverBaseUrl ?? defaults.serverBaseUrl, {
      allowHttp: data?.allowHttp === true,
    })
    return {
      config: {
        version: CONFIG_VERSION,
        serverBaseUrl: normalized.ok ? normalized.baseUrl : defaults.serverBaseUrl,
        updateFeedMode,
        allowHttp: data?.allowHttp === true,
        configured: data?.configured === true,
        updatedAt: data?.updatedAt || null,
      },
      fromFile: true,
    }
  } catch {
    return { config: defaults, fromFile: false }
  }
}

/**
 * @param {string} userDataDir
 * @param {Partial<ReturnType<typeof defaultServerConfig>>} patch
 */
function writeServerConfig(userDataDir, patch) {
  const { config: current } = readServerConfig(userDataDir)
  const allowHttp = patch.allowHttp === true || current.allowHttp === true
  const rawBase = patch.serverBaseUrl != null ? patch.serverBaseUrl : current.serverBaseUrl
  const normalized = normalizeServerBaseUrl(rawBase, { allowHttp: patch.allowHttp === true || allowHttp })
  if (!normalized.ok) return { ok: false, error: normalized.error }

  const updateFeedMode = UPDATE_MODES.includes(patch.updateFeedMode)
    ? patch.updateFeedMode
    : current.updateFeedMode

  const next = {
    version: CONFIG_VERSION,
    serverBaseUrl: normalized.baseUrl,
    updateFeedMode,
    allowHttp: patch.allowHttp === true || (patch.allowHttp == null && current.allowHttp === true),
    configured: patch.configured !== false,
    updatedAt: new Date().toISOString(),
  }

  const filePath = getServerConfigPath(userDataDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8')
  return { ok: true, config: next }
}

/**
 * 站点探测：优先 version.json（{version,buildTime}），否则看首页是否像 Mao。
 * @param {string} baseUrl
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [options]
 */
async function probeServer(baseUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const normalized = normalizeServerBaseUrl(baseUrl, { allowHttp: true })
  if (!normalized.ok) return { ok: false, error: normalized.error }
  const origin = new URL(normalized.baseUrl).origin
  if (!fetchImpl) return { ok: false, error: '当前环境不支持网络探测' }

  const probes = [
    { url: `${origin}/version.json`, kind: 'version' },
    { url: `${origin}/`, kind: 'root' },
  ]

  let lastError = '无法连接该服务器'
  for (const probe of probes) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const resp = await fetchImpl(probe.url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'application/json,text/html,*/*' },
      })
      if (probe.kind === 'version') {
        if (resp.ok) {
          const text = await resp.text()
          try {
            const data = JSON.parse(text)
            if (data && typeof data.version === 'string') {
              return { ok: true, baseUrl: normalized.baseUrl, detail: `version ${data.version}` }
            }
          } catch {
            // fall through
          }
          lastError = 'version.json 响应异常'
        } else {
          lastError = `version.json HTTP ${resp.status}`
        }
      } else {
        if (resp.ok) {
          const text = await resp.text()
          const looksLikeMao =
            /Mao/i.test(text) ||
            /\/assets\//.test(text) ||
            /app-icon/i.test(text)
          if (looksLikeMao) {
            return { ok: true, baseUrl: normalized.baseUrl, detail: '站点可达' }
          }
          return {
            ok: false,
            error: '站点可达，但可能不是 Mao 部署',
            baseUrl: normalized.baseUrl,
          }
        }
        lastError = `站点 HTTP ${resp.status}`
      }
    } catch (e) {
      lastError = e?.name === 'AbortError' ? '连接超时' : (e?.message || '网络错误')
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, error: lastError, baseUrl: normalized.baseUrl }
}

function resolveUpdateFeedUrl(config, envOverride) {
  if (envOverride && String(envOverride).trim()) {
    return { mode: 'env-override', url: String(envOverride).trim() }
  }
  const mode = UPDATE_MODES.includes(config?.updateFeedMode) ? config.updateFeedMode : 'follow-site'
  if (mode === 'disabled' || mode === 'package-default') {
    return { mode, url: null }
  }
  return { mode: 'follow-site', url: deriveUpdateFeedUrl(config?.serverBaseUrl || DEFAULT_SERVER_BASE_URL) }
}

module.exports = {
  DEFAULT_SERVER_BASE_URL,
  UPDATE_MODES,
  normalizeServerBaseUrl,
  deriveApiBase,
  deriveUpdateFeedUrl,
  serverHostKey,
  getServerConfigPath,
  defaultServerConfig,
  readServerConfig,
  writeServerConfig,
  probeServer,
  resolveUpdateFeedUrl,
  getConfigVersion,
}
