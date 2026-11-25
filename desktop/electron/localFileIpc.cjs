'use strict'

// 本地文件 IPC 与 WS tool-execute 共享的读写实现（自 main.cjs 抽出，技术方案 2026-11-19 §5.7）。
// 模块本身不 require('electron')：nativeImage 由入口注入，单测不必起 Electron。
// 审批差异留在各自入口（§2.4/D6）：IPC 通道每次审批（不带 sessionId/requestId），
// WS 入口仅 needApproval 时审批；两条入口共用 writeFileWithDiff / writeEditedFile 的落盘实现。

const fs = require('fs')
const path = require('path')
const {
  PRIVATE_DIFF_FIELD,
  computeLineDelta,
  buildFileChangeDiff,
  asBoolArg,
  writeEditedFile,
} = require('./fileChangeDiff.cjs')
const { readFileBytes } = require('./localFileBytes.cjs')
const { readWorkspaceBytes } = require('./localWorkspaceRead.cjs')
const { openDeliveryFile, readDeliveryChunk, closeDeliveryFile, digestDeliveryFile } = require('./localDeliveryStream.cjs')
const promptImageResizer = require('./promptImageResizer.cjs')

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase()
  for (const [ext, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (lower.endsWith(ext)) return mime
  }
  return null
}

function detectMimeFromBytes(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  return null
}

function formatImageSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 两条写文件入口共享的落盘实现：存在则读原文、建目录、写入、算行差与 diff。
 * 审批（每次 / needApproval）由调用方先完成；返回形状两侧一致（§2.4）。
 */
function writeFileWithDiff(resolvedPath, filePathArg, content) {
  const fileExisted = fs.existsSync(resolvedPath)
  const beforeContent = fileExisted ? fs.readFileSync(resolvedPath, 'utf-8') : ''
  const dir = path.dirname(resolvedPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(resolvedPath, content, 'utf-8')
  const linesAdded = content.length === 0 ? 0 : content.split('\n').length
  const lineDelta = fileExisted
    ? computeLineDelta(beforeContent, content)
    : { linesAdded, linesDeleted: 0 }
  return {
    success: true,
    bytes_written: Buffer.byteLength(content, 'utf-8'),
    file_change: {
      path: filePathArg,
      type: fileExisted ? 'MODIFIED' : 'CREATED',
      lines_added: lineDelta.linesAdded,
      lines_deleted: lineDelta.linesDeleted
    },
    [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePathArg, beforeContent, content)
  }
}

function extractFilePath(args) {
  return args.path || args.file || args.filePath || args.file_path || args.target_file
}

/**
 * deps：
 * - resolveWorkspacePath(filePath, workspace, sessionId)：来自 localRuntimePaths（入口注入）
 * - requestToolApproval(toolName, description, sessionId?, dangerReason?, requestId?)：审批留在入口（§7）
 * - nativeImage：读图缩放用
 * 返回 handleLocalReadFile / handleLocalWriteFile / handleLocalEditFile 供 executeToolByName 调用。
 */
function registerLocalFileIpc(ipcMain, deps) {
  const { resolveWorkspacePath, requestToolApproval, nativeImage } = deps

  function readLocalImage(resolvedPath, filePath) {
    const sizeBytes = fs.statSync(resolvedPath).size
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return {
        content: `错误：文件过大（${formatImageSize(sizeBytes)}），图片读取上限为 ${formatImageSize(MAX_IMAGE_BYTES)}：${filePath}`,
        total_lines: 0
      }
    }
    const buffer = fs.readFileSync(resolvedPath)
    const mime = detectMimeFromBytes(buffer)
    if (!mime) {
      return {
        content: `错误：不支持的图片格式或文件内容无效：${filePath}`,
        total_lines: 0
      }
    }

    let outBuffer = buffer
    let outMime = mime
    let width = null
    let height = null
    let dimNote = ''

    const resized = promptImageResizer.resizeForPrompt(buffer, mime, nativeImage)
    if (resized) {
      outBuffer = resized.buffer
      outMime = resized.mime
      width = resized.width
      height = resized.height
      if (resized.resized) {
        try {
          const orig = nativeImage.createFromBuffer(buffer)
          if (!orig.isEmpty()) {
            const { width: ow, height: oh } = orig.getSize()
            if (ow && oh && (ow !== width || oh !== height)) {
              dimNote = `, ${ow}×${oh}→${width}×${height}`
            }
          }
        } catch { /* ignore */ }
        if (!dimNote && width && height) {
          dimNote = `, ${width}×${height}`
        }
      } else if (width && height) {
        dimNote = `, ${width}×${height}`
      }
    }

    const outSize = outBuffer.length
    const dataUri = `data:${outMime};base64,${outBuffer.toString('base64')}`
    return {
      content: `图片读取成功：${filePath} (${outMime}, ${formatImageSize(outSize)}${dimNote})`,
      total_lines: 0,
      media_type: 'image',
      mime: outMime,
      path: filePath,
      size_bytes: outSize,
      ...(width != null ? { width } : {}),
      ...(height != null ? { height } : {}),
      data_uri: dataUri
    }
  }

  async function handleLocalReadFile(args, workspace, maoSessionId) {
    try {
      const filePath = extractFilePath(args)
      if (!filePath) {
        return { content: '错误：缺少必填参数 path', total_lines: 0 }
      }
      const resolvedPath = resolveWorkspacePath(filePath, workspace, maoSessionId)
      if (!fs.existsSync(resolvedPath)) {
        return { content: `错误：文件不存在：${filePath}`, total_lines: 0 }
      }
      if (!fs.statSync(resolvedPath).isFile()) {
        return { content: `错误：不是普通文件：${filePath}`, total_lines: 0 }
      }
      if (mimeFromPath(filePath)) {
        return readLocalImage(resolvedPath, filePath)
      }
      const content = fs.readFileSync(resolvedPath, 'utf-8')
      const lines = content.split('\n')
      const start = args.offset || 0
      const end = args.limit ? Math.min(start + args.limit, lines.length) : lines.length
      return { content: lines.slice(start, end).join('\n'), total_lines: lines.length }
    } catch (e) {
      return { content: `错误：${e.message}`, total_lines: 0 }
    }
  }

  async function handleLocalWriteFile(args, workspace, sessionId, needApproval, requestId) {
    if (needApproval) {
      const approved = await requestToolApproval('write_file', args.path, sessionId, null, requestId)
      if (!approved) {
        return { success: false, error: 'User denied file write.' }
      }
    }
    try {
      const resolvedPath = resolveWorkspacePath(args.path, workspace, sessionId)
      return writeFileWithDiff(resolvedPath, args.path, args.content)
    } catch (e) {
      return { error: e.message }
    }
  }

  async function handleLocalEditFile(args, workspace, sessionId, needApproval, requestId) {
    if (needApproval) {
      const approved = await requestToolApproval('edit_file', args.path, sessionId, null, requestId)
      if (!approved) {
        return { success: false, error: 'User denied file edit.' }
      }
    }
    try {
      const resolvedPath = resolveWorkspacePath(args.path, workspace, sessionId)
      return writeEditedFile(
        resolvedPath,
        args.path,
        args.old_string,
        args.new_string,
        asBoolArg(args.replace_all),
      )
    } catch (e) {
      return { error: e.message }
    }
  }

  ipcMain.handle('local-read-file', async (event, { path: filePath, offset, limit }) => {
    try {
      const resolvedPath = resolveWorkspacePath(filePath)
      if (mimeFromPath(filePath)) {
        return readLocalImage(resolvedPath, filePath)
      }
      if (filePath.toLowerCase().endsWith('.pdf')) {
        // PDF 预览：按字节读取并以 base64 data_uri 返回，由渲染进程转为 Blob 交给 pdf.js
        const buffer = fs.readFileSync(resolvedPath)
        return {
          content: `PDF 文件：${filePath}`,
          total_lines: 0,
          media_type: 'pdf',
          mime: 'application/pdf',
          data_uri: `data:application/pdf;base64,${buffer.toString('base64')}`,
        }
      }
      const content = fs.readFileSync(resolvedPath, 'utf-8')
      const lines = content.split('\n')
      const totalLines = lines.length
      const start = offset || 0
      const end = limit ? Math.min(start + limit, totalLines) : totalLines
      const sliced = lines.slice(start, end).join('\n')
      return { content: sliced, total_lines: totalLines }
    } catch (e) {
      return { error: e.message }
    }
  })

  // LOCAL 二进制字节读取（技术方案 §5.2）：zip / xlsx / docx / 媒体预览的取数通道。
  // 路径解析与 local-read-file 共用 resolveWorkspacePath；类型校验与大小上限在
  // localFileBytes.cjs（可单测）。文件全程不出本机，无任何上传语义。
  ipcMain.handle('local-read-bytes', async (event, { path: filePath }) => {
    try {
      const resolvedPath = resolveWorkspacePath(filePath)
      return readFileBytes(resolvedPath)
    } catch (e) {
      return { error: e.message }
    }
  })

  // file_fetch 委托读取（方案 2026-11-18）：workspace + 相对路径在主进程拼装并 containment 校验。
  // 不沿用 local-read-bytes 的绝对路径直通口子；只读操作，不写 currentWorkspace、不走审批。
  ipcMain.handle('local-read-workspace-bytes', async (event, { workspace, path: relativePath }) => {
    try {
      return readWorkspaceBytes(workspace, relativePath)
    } catch (e) {
      return { error: e.message }
    }
  })

  // delivery_read 委托读取（2026-11-25 R2）：send_image / send_file 在 LOCAL 会话读不到本机
  // 文件时由服务端发起。open 只校验路径 + stat 并持有句柄，read 按 offset 读一片，close 释放；
  // 不再整份读入主进程内存。允许根只有本机会话 workspace（相对路径或 workspace 内绝对路径）。
  ipcMain.handle('local-delivery-open', async (event, { workspace, path: filePath, maxBytes }) => {
    try {
      return openDeliveryFile(workspace, filePath, maxBytes)
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('local-delivery-read', async (event, { openId, offset, length }) => {
    try {
      return readDeliveryChunk(openId, offset, length)
    } catch (e) {
      return { error: e.message }
    }
  })

  // 整份 sha256（R8）：发送完成后、关闭句柄前比对；1GB 也不进渲染进程内存
  ipcMain.handle('local-delivery-digest', async (event, { openId }) => {
    try {
      return await digestDeliveryFile(openId)
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('local-delivery-close', async (event, { openId }) => {
    try {
      closeDeliveryFile(openId)
      return { ok: true }
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('local-write-file', async (event, { path: filePath, content }) => {
    const approved = await requestToolApproval('write_file', filePath)
    if (!approved) {
      return { success: false, error: 'User denied file write.' }
    }
    try {
      return writeFileWithDiff(resolveWorkspacePath(filePath), filePath, content)
    } catch (e) {
      return { error: e.message }
    }
  })

  ipcMain.handle('local-edit-file', async (event, { path: filePath, old_string, new_string, replace_all }) => {
    const approved = await requestToolApproval('edit_file', filePath)
    if (!approved) {
      return { success: false, error: 'User denied file edit.' }
    }
    try {
      return writeEditedFile(
        resolveWorkspacePath(filePath),
        filePath,
        old_string,
        new_string,
        asBoolArg(replace_all),
      )
    } catch (e) {
      return { error: e.message }
    }
  })

  const IGNORED_DIRS = new Set(['node_modules', '__pycache__', '.git', 'target', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode'])

  ipcMain.handle('list-workspace-files', async (event, { workspace, filter, limit }) => {
    try {
      if (!workspace || !fs.existsSync(workspace)) return []
      const maxResults = limit || 20
      const results = []

      function walkDir(dir, relativeBase) {
        if (results.length >= maxResults) return
        let entries
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        // Sort entries: files first, then dirs, alphabetically
        entries.sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
          return a.name.localeCompare(b.name)
        })
        for (const entry of entries) {
          if (results.length >= maxResults) return
          if (entry.name.startsWith('.')) continue
          if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
          const fullPath = path.join(dir, entry.name)
          const relPath = relativeBase ? relativeBase + '/' + entry.name : entry.name
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath)
          } else {
            try {
              const stat = fs.statSync(fullPath)
              if (!filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || relPath.toLowerCase().includes(filter.toLowerCase())) {
                results.push({ path: relPath, name: entry.name, size: stat.size, mtime: stat.mtimeMs })
              }
            } catch {
              // skip files we can't stat
            }
          }
        }
      }

      walkDir(workspace, '')
      // Sort by modification time descending
      results.sort((a, b) => b.mtime - a.mtime)
      // Remove mtime from response
      return results.map(({ mtime, ...rest }) => rest)
    } catch (e) {
      return []
    }
  })

  ipcMain.handle('list-directory', async (event, { dirPath, workspace }) => {
    try {
      if (!dirPath || !workspace) return { error: 'Missing dirPath or workspace' }
      const resolvedDir = path.resolve(dirPath)
      const resolvedWorkspace = path.resolve(workspace)
      if (!resolvedDir.startsWith(resolvedWorkspace + path.sep) && resolvedDir !== resolvedWorkspace) {
        return { error: 'Access denied: path outside workspace' }
      }
      if (!fs.existsSync(resolvedDir)) return { error: 'Directory does not exist' }

      const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
      const results = []
      const MAX_ENTRIES = 500

      for (const entry of entries) {
        if (results.length >= MAX_ENTRIES) break

        const fullPath = path.join(resolvedDir, entry.name)
        const relPath = path.relative(resolvedWorkspace, fullPath)
        let isSymlink = false
        let size = 0
        let mtime = 0

        try {
          const lstat = fs.lstatSync(fullPath)
          isSymlink = lstat.isSymbolicLink()
          size = lstat.size
          mtime = lstat.mtimeMs
        } catch {
          // skip entries we can't stat
          continue
        }

        results.push({
          name: entry.name,
          path: relPath,
          isDirectory: entry.isDirectory() && !isSymlink,
          size,
          mtime,
          isSymlink
        })
      }

      // Sort: folders first alphabetically, then files alphabetically
      results.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      return { entries: results, truncated: entries.length > MAX_ENTRIES }
    } catch (e) {
      return { error: e.message }
    }
  })

  return { handleLocalReadFile, handleLocalWriteFile, handleLocalEditFile }
}

module.exports = { registerLocalFileIpc, writeFileWithDiff, mimeFromPath, detectMimeFromBytes }
