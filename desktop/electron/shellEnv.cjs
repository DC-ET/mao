'use strict'

/**
 * 本地 shell 注入给 mao / mao-agent 的站点地址。
 *
 * 桌面端是多服务器客户端：站点地址必须与当前连接的服务器一致（用户可在设置里切换）。
 * 首次启动还没选服务器（configured=false）时不注入——shell 里的 CLI 会自行提示
 * 「未配置站点地址」，避免把示例域名之类的占位值当成真实后端。
 */
function resolveShellMaoBaseUrl({ configured, serverBaseUrl }) {
  if (!configured) return null
  const value = typeof serverBaseUrl === 'string' ? serverBaseUrl.trim() : ''
  return value !== '' ? value : null
}

module.exports = { resolveShellMaoBaseUrl }
