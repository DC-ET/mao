'use strict'

const fs = require('fs')
const path = require('path')

const macPath = path.posix
const APP_BUNDLE_NAME = 'Mao.app'
const SCRIPT_NAME = 'mac-update-install.sh'
const LOG_NAME = 'mac-update-install.log'
const PLAN_NAME = 'mac-update-install-plan.json'

function normalizeMacPath(value) {
  return macPath.normalize(String(value || '').split('\\').join('/'))
}

function resolveMacAppBundle(execPath) {
  const exe = normalizeMacPath(execPath)
  const macosDir = macPath.dirname(exe)
  const contentsDir = macPath.dirname(macosDir)
  const bundle = macPath.dirname(contentsDir)
  if (macPath.basename(macosDir) !== 'MacOS') return null
  if (macPath.basename(contentsDir) !== 'Contents') return null
  if (!bundle.endsWith('.app')) return null
  return bundle
}

function bundleInstallBlocker(bundlePath) {
  if (!bundlePath) return 'not-bundle'
  const normalized = normalizeMacPath(bundlePath)
  if (normalized.includes('/AppTranslocation/')) return 'translocated'
  if (normalized === '/Volumes' || normalized.startsWith('/Volumes/')) return 'disk-image'
  return null
}

function parentCanReplace(bundlePath, accessSync) {
  try {
    accessSync(macPath.dirname(bundlePath), fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function zipExists(zipPath, statSync) {
  if (!zipPath || typeof zipPath !== 'string') return false
  try {
    return statSync(zipPath).isFile()
  } catch {
    return false
  }
}

function planMacInstall({ execPath, zipPath, accessSync = fs.accessSync, statSync = fs.statSync } = {}) {
  const bundlePath = resolveMacAppBundle(execPath)
  const blocker = bundleInstallBlocker(bundlePath)
  if (blocker) return { ok: false, reason: blocker, bundlePath }
  if (!zipExists(zipPath, statSync)) return { ok: false, reason: 'missing-zip', bundlePath }
  if (!parentCanReplace(bundlePath, accessSync)) return { ok: false, reason: 'not-writable', bundlePath }
  return { ok: true, bundlePath, zipPath }
}

function installWaitSeconds() {
  const raw = Number(process.env.MAO_UPDATE_INSTALL_WAIT_SECS)
  if (Number.isFinite(raw) && raw >= 0) return String(Math.floor(raw))
  return '30'
}

function installScript() {
  return `#!/bin/bash
# 等当前进程退出后，用已通过 sha512 校验的 zip 替换正在运行的 .app。
# 不调用 codesign 指定要求校验，因此证书或 ad-hoc 变化不会挡住安装。
set -u
PID="$1"
ZIP="$2"
BUNDLE="$3"
LOG="$4"
APP_NAME="$5"
WAIT="\${6:-30}"
RELAUNCH="\${7:-1}"

log() {
  printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG"
}

case "$APP_NAME" in
  *[/\\\\]*|'') log "bad-name"; exit 1 ;;
esac
case "$BUNDLE" in
  */"$APP_NAME") ;;
  *) log "bad-bundle"; exit 1 ;;
esac

deadline=$(( $(date +%s) + WAIT ))
while kill -0 "$PID" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "still-running"
    exit 1
  fi
  sleep 0.2
done

STAGE=$(mktemp -d "\${TMPDIR:-/tmp}/mao-update.XXXXXX")
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

if ! ditto -x -k "$ZIP" "$STAGE"; then
  log "unzip-failed"
  exit 1
fi

NEW_APP="$STAGE/$APP_NAME"
if [ ! -d "$NEW_APP" ] || [ -L "$NEW_APP" ]; then
  log "missing-app"
  exit 1
fi

PARENT=$(dirname "$BUNDLE")
BACKUP="$PARENT/.Mao.update-backup.$$"
rm -rf "$BACKUP"
if ! mv "$BUNDLE" "$BACKUP"; then
  log "move-aside-failed"
  exit 1
fi
if ! mv "$NEW_APP" "$BUNDLE"; then
  mv "$BACKUP" "$BUNDLE" || log "restore-failed"
  log "move-in-failed"
  exit 1
fi
rm -rf "$BACKUP"
xattr -dr com.apple.quarantine "$BUNDLE" 2>/dev/null || true
if [ "$RELAUNCH" = "1" ]; then
  open "$BUNDLE" || log "relaunch-failed"
fi
log "ok"
`
}

function writeInstallScript(scriptPath) {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true })
  fs.writeFileSync(scriptPath, installScript(), 'utf8')
  fs.chmodSync(scriptPath, 0o755)
}

module.exports = {
  APP_BUNDLE_NAME,
  SCRIPT_NAME,
  LOG_NAME,
  PLAN_NAME,
  resolveMacAppBundle,
  bundleInstallBlocker,
  planMacInstall,
  installWaitSeconds,
  installScript,
  writeInstallScript,
}
