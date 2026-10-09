import type { InternalAxiosRequestConfig } from 'axios'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'
const SKIP_BUSINESS_CODES = [3044, 3045]
const OVERWRITE_OPS = new Set(['write', 'copy', 'upload'])

export interface UploadItem {
  file: File
  relativePath: string
}

export interface UploadProgress {
  label: string
  percent: number
  error: string
}

interface Flags {
  force?: boolean
  overwrite?: boolean
}

interface WriteResult {
  path: string
}

function writeConfig(): InternalAxiosRequestConfig {
  return { timeout: 0, skipBusinessCodes: SKIP_BUSINESS_CODES } as unknown as InternalAxiosRequestConfig
}

function asError(e: unknown): Error & { code?: number; toastShown?: boolean } {
  if (e instanceof Error) return e as Error & { code?: number; toastShown?: boolean }
  return new Error('操作失败')
}

async function confirmForce(message: string): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      `${message}\n\n强制操作可能导致 Agent 出错`,
      '文件正在被 Agent 写入',
      {
        confirmButtonText: '取消',
        cancelButtonText: '强制操作',
        distinguishCancelAndClose: true,
        closeOnClickModal: false,
        type: 'warning',
      },
    )
    return false
  } catch (action) {
    return action === 'cancel'
  }
}

async function confirmOverwrite(): Promise<boolean> {
  try {
    await ElMessageBox.confirm('目标已存在，是否覆盖？', '目标已存在', {
      confirmButtonText: '覆盖',
      cancelButtonText: '取消',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

async function withPrompts<T>(op: string, run: (flags: Flags) => Promise<T>, flags: Flags = {}): Promise<T> {
  try {
    return await run(flags)
  } catch (e) {
    const err = asError(e)
    if (err.code === 3044 && !flags.force) {
      const forced = await confirmForce(err.message)
      if (!forced) throw err
      return withPrompts(op, run, { ...flags, force: true })
    }
    if (err.code === 3045 && OVERWRITE_OPS.has(op) && !flags.overwrite) {
      const overwrite = await confirmOverwrite()
      if (!overwrite) throw err
      return withPrompts(op, run, { ...flags, overwrite: true })
    }
    if (err.code === 3045 || (err.code !== 3044 && !err.toastShown)) {
      ElMessage.error(err.message || '操作失败')
    }
    throw err
  }
}

function flagsOf(flags: Flags): { force?: boolean; overwrite?: boolean } {
  return {
    ...(flags.force ? { force: true } : {}),
    ...(flags.overwrite ? { overwrite: true } : {}),
  }
}

export function mkdirWorkspace(sessionId: number, path: string) {
  return withPrompts('mkdir', async (flags) => {
    const res = await api.post('/files/workspace-mkdir', { sessionId, path, ...flagsOf(flags) }, writeConfig())
    return res.data as WriteResult
  })
}

export function writeWorkspaceFile(sessionId: number, path: string, content = '') {
  return withPrompts('write', async (flags) => {
    const res = await api.post('/files/workspace-write', { sessionId, path, content, ...flagsOf(flags) }, writeConfig())
    return res.data as WriteResult
  })
}

export function renameWorkspacePath(sessionId: number, path: string, newName: string) {
  return withPrompts('rename', async (flags) => {
    const res = await api.post('/files/workspace-rename', { sessionId, path, newName, ...flagsOf(flags) }, writeConfig())
    return res.data as WriteResult
  })
}

export function moveWorkspacePath(sessionId: number, from: string, to: string) {
  return withPrompts('move', async (flags) => {
    const res = await api.post('/files/workspace-move', { sessionId, from, to, ...flagsOf(flags) }, writeConfig())
    return res.data as WriteResult
  })
}

export function copyWorkspacePath(sessionId: number, from: string, to: string) {
  return withPrompts('copy', async (flags) => {
    const res = await api.post('/files/workspace-copy', { sessionId, from, to, ...flagsOf(flags) }, writeConfig())
    return res.data as WriteResult
  })
}

export function deleteWorkspacePath(sessionId: number, path: string) {
  return withPrompts('delete', async (flags) => {
    const res = await api.delete('/files/workspace-delete', {
      ...writeConfig(),
      params: { sessionId, path, ...(flags.force ? { force: 'true' } : {}) },
    })
    return res.data as WriteResult
  })
}

export function uploadWorkspace(
  sessionId: number,
  dir: string,
  items: UploadItem[],
  onProgress?: (progress: UploadProgress) => void,
) {
  const label = items.length === 1 ? items[0].relativePath : `${items.length} 个文件`
  return withPrompts('upload', (flags) => sendUpload(sessionId, dir, items, label, flags, onProgress))
}

function sendUpload(
  sessionId: number,
  dir: string,
  items: UploadItem[],
  label: string,
  flags: Flags,
  onProgress?: (progress: UploadProgress) => void,
): Promise<WriteResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `${API_BASE}/files/workspace-upload`)
    xhr.timeout = 0
    const token = getToken()
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = (event) => {
      const percent = event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : 0
      onProgress?.({ label, percent, error: '' })
    }
    xhr.onload = () => {
      let body: { code?: number; message?: string; data?: WriteResult } = {}
      try {
        body = JSON.parse(xhr.responseText || '{}')
      } catch {
        body = {}
      }
      if (body.code === 0 && body.data) {
        onProgress?.({ label, percent: 100, error: '' })
        resolve(body.data)
        return
      }
      const err = new Error(body.message || '上传失败') as Error & { code?: number }
      err.code = body.code
      onProgress?.({ label, percent: 0, error: err.message })
      reject(err)
    }
    xhr.onerror = () => {
      const err = new Error('上传失败，请重试')
      onProgress?.({ label, percent: 0, error: err.message })
      reject(err)
    }
    const form = new FormData()
    form.append('sessionId', String(sessionId))
    form.append('dir', dir || '.')
    if (flags.force) form.append('force', 'true')
    if (flags.overwrite) form.append('overwrite', 'true')
    for (const item of items) {
      form.append('relativePath', item.relativePath)
      form.append('file', item.file, item.file.name)
    }
    xhr.send(form)
  })
}

export async function filesFromDataTransfer(data: DataTransfer): Promise<UploadItem[]> {
  const entries: FileSystemEntry[] = []
  for (const item of data.items) {
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) {
    return [...data.files].map((file) => ({
      file,
      relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }))
  }
  const out: UploadItem[] = []
  for (const entry of entries) {
    out.push(...await walkEntry(entry, ''))
  }
  return out
}

async function walkEntry(entry: FileSystemEntry, prefix: string): Promise<UploadItem[]> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry
    const file = await new Promise<File | null>((resolve) => fileEntry.file((f) => resolve(f), () => resolve(null)))
    if (!file) return []
    return [{ file, relativePath: prefix ? `${prefix}/${file.name}` : file.name }]
  }
  const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
  const children = await readAllEntries(entry as FileSystemDirectoryEntry)
  const out: UploadItem[] = []
  for (const child of children) {
    out.push(...await walkEntry(child, dirPrefix))
  }
  return out
}

function readAllEntries(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve) => {
    const pull = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        pull()
      }, () => resolve(all))
    }
    pull()
  })
}

export function filesFromInput(list: FileList | null): UploadItem[] {
  if (!list) return []
  return [...list].map((file) => ({
    file,
    relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  }))
}
