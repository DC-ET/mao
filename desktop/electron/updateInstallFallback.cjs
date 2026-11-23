'use strict'

const fs = require('fs')
const path = require('path')

const ATTEMPT_FILE = 'update-install-attempt.json'

function attemptPath(userDataDir) {
  return path.join(String(userDataDir || ''), ATTEMPT_FILE)
}

function readInstallAttempt(userDataDir) {
  try {
    const data = JSON.parse(fs.readFileSync(attemptPath(userDataDir), 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    return data
  } catch {
    return null
  }
}

function writeInstallAttempt(userDataDir, attempt) {
  const filePath = attemptPath(userDataDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(attempt, null, 2), 'utf8')
}

function clearInstallAttempt(userDataDir) {
  try {
    fs.unlinkSync(attemptPath(userDataDir))
  } catch {
    // 没有记录就不必删
  }
}

function markInstallAttemptPrompted(userDataDir) {
  const current = readInstallAttempt(userDataDir)
  if (!current) return null
  const next = { ...current, prompted: true }
  writeInstallAttempt(userDataDir, next)
  return next
}

function snapshotUpdateInfo(info) {
  const files = Array.isArray(info?.files)
    ? info.files.map((file) => {
      if (typeof file === 'string') return { url: file }
      if (!file || typeof file.url !== 'string' || !file.url) return null
      const entry = { url: file.url }
      if (typeof file.arch === 'string' && file.arch) entry.arch = file.arch
      return entry
    }).filter(Boolean)
    : []
  return {
    version: typeof info?.version === 'string' && info.version ? info.version : null,
    files,
  }
}

/**
 * 下次启动时怎么处理上次的安装尝试。
 * success：版本已经变了，清掉记录。
 * prompt：还是旧版本，而且这次失败还没提示过。
 * ignore：没有记录，或已经提示过。
 */
function classifyLaunchAttempt(attempt, currentVersion) {
  if (!attempt || typeof attempt.toVersion !== 'string' || !attempt.toVersion) return 'ignore'
  const current = String(currentVersion || '')
  if (current === attempt.toVersion) return 'success'
  if (typeof attempt.fromVersion === 'string' && attempt.fromVersion && current !== attempt.fromVersion) {
    return 'success'
  }
  if (attempt.prompted === true) return 'ignore'
  return 'prompt'
}

function isDmgUrl(url) {
  const pathName = String(url || '').split('?')[0].split('#')[0]
  return pathName.toLowerCase().endsWith('.dmg')
}

function pickManualDmg(files, arch) {
  const dmgs = (Array.isArray(files) ? files : []).filter((file) => file && isDmgUrl(file.url))
  if (arch === 'arm64') {
    const hit = dmgs.find((file) => file.arch === 'arm64' || /arm64/i.test(file.url))
    return hit ? hit.url : null
  }
  const intel = dmgs.find((file) => file.arch === 'x64' || /intel/i.test(file.url))
    || dmgs.find((file) => file.arch !== 'arm64' && !/arm64/i.test(file.url))
  return intel ? intel.url : null
}

function resolveManualDmgUrl(feedUrl, fileUrl) {
  if (!fileUrl || typeof fileUrl !== 'string') return null
  try {
    if (/^https?:\/\//i.test(fileUrl)) return fileUrl
    if (!feedUrl) return null
    return new URL(fileUrl, feedUrl).href
  } catch {
    return null
  }
}

function manualInstallDialogCopy(toVersion) {
  const versionLabel = toVersion ? ` ${toVersion}` : ''
  return {
    title: '自动更新没有完成',
    message: `客户端${versionLabel} 已下载，但没有安装成功。请下载安装包，退出 Mao 后用里面的应用替换「应用程序」中的旧版本。`,
    confirmLabel: '下载安装包',
    dismissLabel: '稍后',
  }
}

function installStallMs() {
  const raw = Number(process.env.MAO_UPDATE_INSTALL_STALL_MS)
  if (Number.isFinite(raw) && raw >= 0) return raw
  return 3000
}

module.exports = {
  ATTEMPT_FILE,
  attemptPath,
  readInstallAttempt,
  writeInstallAttempt,
  clearInstallAttempt,
  markInstallAttemptPrompted,
  snapshotUpdateInfo,
  classifyLaunchAttempt,
  pickManualDmg,
  resolveManualDmgUrl,
  manualInstallDialogCopy,
  installStallMs,
}
