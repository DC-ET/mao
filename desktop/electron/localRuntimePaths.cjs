'use strict'

// ~/.mao/runtime 会话目录与 workspace 路径解析（自 main.cjs 抽出，技术方案 2026-11-19 §5.3）。
// 不依赖 Electron；hostKey 与 currentWorkspace 由入口注入（D3：模块只读，不持有可变状态）。
// 行为保持：绝对路径原样返回（含 workspace 之外的路径），本方案不新增沙箱。

const fs = require('fs')
const os = require('os')
const path = require('path')

const LOCAL_RUNTIME_ROOT = path.join(os.homedir(), '.mao', 'runtime')

function createLocalRuntimePaths({ getServerHostKey, getCurrentWorkspace } = {}) {
  function resolveLocalRuntimeDir(sessionId) {
    return path.join(LOCAL_RUNTIME_ROOT, getServerHostKey(), String(sessionId))
  }

  function resolveLocalSkillsDir(sessionId) {
    return path.join(resolveLocalRuntimeDir(sessionId), 'skills')
  }

  function resolveLocalShellOutputDir(sessionId) {
    return path.join(resolveLocalRuntimeDir(sessionId), 'shellOutput')
  }

  /** 展示用路径：保持 ~/.mao/runtime/... 形式，不展开 home */
  function formatLocalRuntimePath(sessionId, ...segments) {
    return ['~/.mao/runtime', getServerHostKey(), String(sessionId), ...segments].join('/')
  }

  function expandHomePath(filePath) {
    if (!filePath) return filePath
    if (filePath === '~') return os.homedir()
    if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2))
    return filePath
  }

  function isUnderLocalRuntime(absolutePath, maoSessionId) {
    if (!maoSessionId) return false
    const runtimeDir = resolveLocalRuntimeDir(maoSessionId)
    const resolved = path.resolve(absolutePath)
    return resolved === runtimeDir || resolved.startsWith(runtimeDir + path.sep)
  }

  function resolveWorkspacePath(filePath, workspace, maoSessionId) {
    const effectiveWorkspace = workspace || (getCurrentWorkspace ? getCurrentWorkspace() : '')
    if (!filePath) return filePath

    const expanded = expandHomePath(filePath)
    if (path.isAbsolute(expanded)) {
      if (maoSessionId && isUnderLocalRuntime(expanded, maoSessionId)) {
        return expanded
      }
      return expanded
    }
    if (!effectiveWorkspace) return expanded
    return path.join(effectiveWorkspace, expanded)
  }

  return {
    resolveLocalRuntimeDir,
    resolveLocalSkillsDir,
    resolveLocalShellOutputDir,
    formatLocalRuntimePath,
    expandHomePath,
    isUnderLocalRuntime,
    resolveWorkspacePath,
  }
}

module.exports = { createLocalRuntimePaths, LOCAL_RUNTIME_ROOT }
