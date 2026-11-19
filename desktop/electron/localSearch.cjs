'use strict'

// glob_search / grep_search 领域逻辑（自 main.cjs 抽出，技术方案 2026-11-19 §5.2）。
// 不依赖 Electron：rg 探测缓存与 execFile 都在工厂闭包内，单测可注入假 execFile 走 Node 回退；
// 路径解析与 currentWorkspace 由调用方注入（D3：模块不持有可变工作区状态）。

const fs = require('fs')
const path = require('path')

function createLocalSearch({ resolveWorkspacePath, getCurrentWorkspace, execFileImpl } = {}) {
  const execFile = execFileImpl || require('child_process').execFile

  let rgAvailable = null
  async function isRgAvailable() {
    if (rgAvailable !== null) return rgAvailable
    try {
      await new Promise((resolve, reject) => {
        execFile('rg', ['--version'], (err) => err ? reject(err) : resolve())
      })
      rgAvailable = true
    } catch {
      rgAvailable = false
    }
    return rgAvailable
  }

  async function handleLocalGlobSearch(args, workspace, maoSessionId) {
    const pattern = args.pattern
    if (!pattern) return { files: [], error: 'pattern is required' }

    const headLimit = args.head_limit || 100
    const resolvedPath = args.path
      ? resolveWorkspacePath(args.path, workspace, maoSessionId)
      : (workspace || getCurrentWorkspace() || '.')

    try {
      const scope = resolveSearchScope(resolvedPath)
      let files = []
      if (await isRgAvailable()) {
        files = await globWithRg(pattern, scope, headLimit)
      } else {
        files = globWithNode(pattern, scope, headLimit)
      }

      const truncated = files.length >= headLimit
      return {
        files,
        search_root: scope.cwd,
        truncated,
        total_matched: files.length
      }
    } catch (e) {
      return { files: [], error: e.message }
    }
  }

  function globWithRg(pattern, scope, headLimit) {
    return new Promise((resolve, reject) => {
      execFile('rg', ['--files', '--glob', pattern, scope.rgTarget], { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return reject(err)
        const lines = (stdout || '').split('\n').filter(Boolean).slice(0, headLimit)
        resolve(lines.map(l => relativizeRgPath(l, scope.cwd)))
      })
    })
  }

  async function handleLocalGrepSearch(args, workspace, maoSessionId) {
    const pattern = args.pattern
    if (!pattern) return { matches: [], error: 'pattern is required' }

    const glob = args.glob || null
    const ignoreCase = args.ignore_case || false
    const contextLines = args.context_lines || 0
    const maxOutputChars = args.max_output_chars || 10000
    const resolvedPath = args.path
      ? resolveWorkspacePath(args.path, workspace, maoSessionId)
      : (workspace || getCurrentWorkspace() || '.')
    const workspaceRoot = workspace || getCurrentWorkspace() || '.'

    try {
      const scope = resolveSearchScope(resolvedPath)
      if (await isRgAvailable()) {
        return await grepWithRg(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars)
      } else {
        return grepWithNode(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars)
      }
    } catch (e) {
      return { matches: [], error: e.message }
    }
  }

  function grepWithRg(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars) {
    return new Promise((resolve, reject) => {
      const cmd = ['--line-number', '--no-heading']
      if (ignoreCase) cmd.push('--ignore-case')
      if (contextLines > 0) { cmd.push('--context'); cmd.push(String(contextLines)) }
      if (glob) { cmd.push('--glob'); cmd.push(glob) }
      cmd.push(pattern)
      cmd.push(scope.rgTarget)

      execFile('rg', cmd, { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve({ matches: [], truncated: false, total_matches: 0 })

        const lines = (stdout || '').split('\n').filter(Boolean)
        const matches = []
        let totalMatches = 0
        let charsUsed = 0
        let truncated = false

        for (const line of lines) {
          if (charsUsed + line.length + 1 > maxOutputChars) {
            truncated = true
            break
          }
          const parsed = parseRgLine(line, scope, workspaceRoot)
          if (parsed) {
            matches.push(parsed)
            totalMatches++
            charsUsed += line.length + 1
          }
        }

        resolve({ matches, truncated, total_matches: totalMatches })
      })
    })
  }

  return {
    handleGlobSearch: handleLocalGlobSearch,
    handleGrepSearch: handleLocalGrepSearch,
  }
}

function resolveSearchScope(resolvedPath) {
  let stat
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    throw new Error(`Search path does not exist or is not accessible: ${resolvedPath}`)
  }
  if (stat.isFile()) {
    const cwd = path.dirname(resolvedPath)
    return { cwd, rgTarget: path.basename(resolvedPath), singleFile: resolvedPath }
  }
  return { cwd: resolvedPath, rgTarget: '.', singleFile: null }
}

function outputFilePath(scope, rgFilePath, workspaceRoot) {
  if (scope.singleFile) {
    const normalized = path.normalize(scope.singleFile)
    if (workspaceRoot && normalized.startsWith(path.normalize(workspaceRoot))) {
      return path.relative(workspaceRoot, normalized)
    }
    return path.basename(normalized)
  }
  return relativizeRgPath(rgFilePath, scope.cwd)
}

function relativizeRgPath(filePath, searchRoot) {
  const trimmed = filePath.startsWith('./') ? filePath.slice(2) : filePath
  if (path.isAbsolute(trimmed)) {
    const normalized = path.normalize(trimmed)
    return normalized.startsWith(searchRoot) ? path.relative(searchRoot, normalized) : normalized
  }
  return path.normalize(trimmed)
}

function globWithNode(pattern, scope, headLimit) {
  const { minimatch } = require('minimatch')
  const files = []
  const searchRoot = scope.cwd

  function walk(dir) {
    if (files.length >= headLimit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= headLimit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        const relative = path.relative(searchRoot, fullPath)
        if (minimatch(relative, pattern) || minimatch(entry.name, pattern)) {
          files.push(relative)
        }
      }
    }
  }

  walk(searchRoot)
  return files
}

function parseRgLine(line, scope, workspaceRoot) {
  if (scope.singleFile) {
    return parseRgSingleFileLine(line, scope, workspaceRoot)
  }

  const firstColon = line.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = line.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null

  const filePath = line.substring(0, firstColon)
  const lineNumStr = line.substring(firstColon + 1, secondColon)
  const content = line.substring(secondColon + 1)

  const lineNum = parseInt(lineNumStr, 10)
  if (isNaN(lineNum)) {
    const firstDash = line.indexOf('-')
    if (firstDash < 0) return null
    const secondDash = line.indexOf('-', firstDash + 1)
    if (secondDash < 0) return null
    const dashLineNum = parseInt(line.substring(firstDash + 1, secondDash), 10)
    if (isNaN(dashLineNum)) return null
    return { file: outputFilePath(scope, line.substring(0, firstDash), workspaceRoot), line: dashLineNum, content: line.substring(secondDash + 1) }
  }

  return { file: outputFilePath(scope, filePath, workspaceRoot), line: lineNum, content }
}

function parseRgSingleFileLine(line, scope, workspaceRoot) {
  const colon = line.indexOf(':')
  const dash = line.indexOf('-')
  let sepIdx
  if (colon > 0 && (dash < 0 || colon < dash)) {
    sepIdx = colon
  } else if (dash > 0) {
    sepIdx = dash
  } else {
    return null
  }

  const lineNum = parseInt(line.substring(0, sepIdx), 10)
  if (isNaN(lineNum)) return null

  return { file: outputFilePath(scope, '', workspaceRoot), line: lineNum, content: line.substring(sepIdx + 1) }
}

function grepWithNode(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars) {
  const { minimatch } = require('minimatch')
  const flags = ignoreCase ? 'i' : ''
  let regex
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return { matches: [], error: 'Invalid regex pattern: ' + pattern }
  }

  const matches = []
  let totalMatches = 0
  let charsUsed = 0
  let truncated = false

  function scanFile(fullPath) {
    if (truncated) return
    if (glob && !minimatch(path.basename(fullPath), glob)) return

    let lines
    try { lines = fs.readFileSync(fullPath, 'utf-8').split('\n') } catch { return }

    const relative = outputFilePath(scope, fullPath, workspaceRoot)

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const match = { file: relative, line: i + 1, content: lines[i] }

        if (contextLines > 0) {
          const before = []
          for (let c = Math.max(0, i - contextLines); c < i; c++) before.push(lines[c])
          const after = []
          for (let c = i + 1; c <= Math.min(lines.length - 1, i + contextLines); c++) after.push(lines[c])
          if (before.length > 0) match.context_before = before
          if (after.length > 0) match.context_after = after
        }

        const entrySize = JSON.stringify(match).length
        if (charsUsed + entrySize > maxOutputChars) {
          truncated = true
          break
        }

        matches.push(match)
        totalMatches++
        charsUsed += entrySize
      }
    }
  }

  function walk(dir) {
    if (truncated) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (truncated) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        scanFile(fullPath)
      }
    }
  }

  if (scope.singleFile) {
    scanFile(scope.singleFile)
  } else {
    walk(scope.cwd)
  }
  return { matches, truncated, total_matches: totalMatches }
}

module.exports = { createLocalSearch, parseRgLine }
