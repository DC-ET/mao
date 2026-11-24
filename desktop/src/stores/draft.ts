import { defineStore } from 'pinia'
import { ref } from 'vue'
import { generateUUID } from '../utils/uuid'
import {
  getDraftPersistence,
  isDraftPersistenceEnabled,
  isValidDraftMeta,
  restoreDraftFile,
  type BlobPut,
  type DraftFileMeta,
  type DraftMeta,
  type DraftPersistence,
} from './draft-persist'

/** 单个输入框草稿：文本 + 待发附件。按会话/新建任务/边路任务键隔离。 */
export interface DraftFileRef {
  file: File
  previewUrl: string
  localPath?: string
  /** 再次标注用的原图。与 file 同一引用表示还没标过。 */
  originalFile?: File
}

export interface DraftEntry {
  /** TipTap 编辑器 HTML（含 quickCommand / fileReference 自定义节点） */
  html: string
  /** 纯文本（用于空判断） */
  text: string
  /**
   * 待发图片/文件及其 blob 预览 URL（previewUrl '' 表示非图片）；所有权随草稿转移。
   * localPath：LOCAL 模式非图片文件在本机的绝对路径（发送时拷贝到 ~/.mao/attachments）。
   */
  files: DraftFileRef[]
  /** 回复选区引用。旧草稿没有这个字段，恢复时当成空数组。 */
  quotes?: Array<{ id: string; text: string; truncated: boolean }>
}

export type DraftPersistMode = 'debounce' | 'now'

export interface RestoredDraftFile {
  file: File
  originalFile: File
  localPath: string
}

const DEBOUNCE_MS = 300
const DEFAULT_MAX_DRAFTS = 30
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024

let maxDrafts = DEFAULT_MAX_DRAFTS
let maxBytes = DEFAULT_MAX_BYTES
let warnedSave = false
let warnedRestore = false
let flushHandler: (() => void) | null = null

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const run = () => flushHandler?.()
  window.addEventListener('pagehide', run)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') run()
  })
}

/** 单测把额度调小，避免构造 200MB 的 File。传 null 恢复默认。 */
export function setDraftLimitsForTests(limits: { maxDrafts: number; maxBytes: number } | null): void {
  maxDrafts = limits?.maxDrafts ?? DEFAULT_MAX_DRAFTS
  maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES
}

/** TipTap 空文档 getHTML() 的残留结构（空段落/空行），视为无内容 */
function isEmptyHtml(html: string): boolean {
  return html.replace(/<p><\/p>|<br>|<\/?p>/g, '').trim() === ''
}

function isEmptyDraft(entry: DraftEntry): boolean {
  if (entry.files.length > 0) return false
  if (entry.quotes && entry.quotes.length > 0) return false
  return !entry.text.trim() && isEmptyHtml(entry.html)
}

function isEmptyMeta(meta: DraftMeta): boolean {
  if (meta.files.length > 0) return false
  if (meta.quotes.length > 0) return false
  return !meta.text.trim() && isEmptyHtml(meta.html)
}

/** 边路占位 Tab（side:0 / side:负数）刷新后不会重建，只留在当页内存。 */
export function isPlaceholderSideKey(key: string): boolean {
  const matched = /^side:(.+)$/.exec(key)
  if (!matched) return false
  const id = Number(matched[1])
  return !Number.isInteger(id) || id <= 0
}

function filePart(file: File, localPath: string): string {
  return [file.name, file.size, file.lastModified, localPath].join('\0')
}

function fileFingerprint(item: DraftFileRef): string {
  const original = item.originalFile && item.originalFile !== item.file
    ? filePart(item.originalFile, '')
    : ''
  return `${filePart(item.file, item.localPath ?? '')}\0${original}`
}

function metaFingerprint(meta: DraftFileMeta): string {
  const original = meta.originalBlobId
    ? [meta.originalName ?? '', meta.originalSize ?? 0, meta.originalLastModified ?? 0, ''].join('\0')
    : ''
  return `${[meta.name, meta.size, meta.lastModified, meta.localPath].join('\0')}\0${original}`
}

function filesFingerprint(entry: DraftEntry): string {
  return entry.files.map(fileFingerprint).join('\n')
}

function listedBytes(files: DraftFileMeta[]): number {
  return files.reduce((sum, file) => sum + file.size + (file.originalSize ?? 0), 0)
}

function warnOnce(kind: 'save' | 'restore'): void {
  if (kind === 'save') {
    if (warnedSave) return
    warnedSave = true
  } else {
    if (warnedRestore) return
    warnedRestore = true
  }
  if (typeof window === 'undefined') return
  const text = kind === 'save' ? '草稿附件未能保存，刷新后将丢失' : '草稿附件未能恢复'
  void import('element-plus').then(({ ElMessage }) => {
    ElMessage.warning(text)
  }).catch(() => {})
}

interface BuiltWrite {
  meta: DraftMeta
  blobs: BlobPut[]
  deleteBlobIds: string[]
}

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Map<string, DraftEntry>>(new Map())
  /** 已被显式清除的键：卸载兜底保存时跳过，防止已删会话/任务的草稿复活 */
  const clearedKeys = new Set<string>()
  /** hydrate 到的、或上一次成功落库的 meta。字节还没读进 Map 时，恢复走这里。 */
  const metas = new Map<string, DraftMeta>()
  const lastFiles = new Map<string, DraftFileMeta[]>()
  const fileLoading = new Set<string>()
  const loadTokens = new Map<string, number>()
  const generation = new Map<string, number>()
  const rerun = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const inflightJobs = new Map<string, Promise<void>>()
  const activeCounts = new Map<string, number>()
  const failedWrites = new Map<string, number>()
  const blobSuppressed = new Set<string>()
  const suppressedFp = new Map<string, string>()
  let userId: number | null = null
  let epoch = 0
  let hydrateInflight: Promise<void> | null = null

  function bump(key: string): number {
    const next = (generation.get(key) ?? 0) + 1
    generation.set(key, next)
    return next
  }

  function canPersist(key: string): boolean {
    return isDraftPersistenceEnabled() && userId != null && !isPlaceholderSideKey(key)
  }

  function dropMemory(key: string): void {
    if (drafts.value.has(key)) {
      const next = new Map(drafts.value)
      next.delete(key)
      drafts.value = next
    }
    metas.delete(key)
    lastFiles.delete(key)
    blobSuppressed.delete(key)
    suppressedFp.delete(key)
  }

  function clearTimer(key: string): void {
    const timer = timers.get(key)
    if (timer) clearTimeout(timer)
    timers.delete(key)
  }

  function protectSet(key: string): Set<string> {
    const protectedKeys = new Set<string>([key, ...fileLoading, ...activeCounts.keys()])
    return protectedKeys
  }

  function getDraft(key: string): DraftEntry | undefined {
    return drafts.value.get(String(key))
  }

  function getDraftMeta(key: string): DraftMeta | undefined {
    const meta = metas.get(String(key))
    return meta ? { ...meta, quotes: meta.quotes.map(quote => ({ ...quote })), files: meta.files.map(file => ({ ...file })) } : undefined
  }

  function hasDraft(key: string): boolean {
    return drafts.value.has(String(key))
  }

  function isFileLoading(key: string): boolean {
    return fileLoading.has(String(key))
  }

  function isCurrentLoad(key: string, token: number): boolean {
    return fileLoading.has(String(key)) && loadTokens.get(String(key)) === token
  }

  function activateDraftKey(key: string): void {
    const id = String(key)
    activeCounts.set(id, (activeCounts.get(id) ?? 0) + 1)
  }

  function deactivateDraftKey(key: string): void {
    const id = String(key)
    const next = (activeCounts.get(id) ?? 1) - 1
    if (next <= 0) activeCounts.delete(id)
    else activeCounts.set(id, next)
  }

  function startFileLoad(key: string): number {
    const id = String(key)
    fileLoading.add(id)
    const token = (loadTokens.get(id) ?? 0) + 1
    loadTokens.set(id, token)
    return token
  }

  function cancelFileLoad(key: string): void {
    const id = String(key)
    fileLoading.delete(id)
    loadTokens.set(id, (loadTokens.get(id) ?? 0) + 1)
  }

  function finishFileLoad(key: string, token: number, entry: DraftEntry): void {
    const id = String(key)
    if (loadTokens.get(id) !== token) return
    fileLoading.delete(id)
    if (isEmptyDraft(entry)) {
      dropMemory(id)
      schedule(id, 'now')
      return
    }
    const next = new Map(drafts.value)
    next.set(id, entry)
    drafts.value = next
  }

  /** 写入草稿；内容为空时改为删除条目，避免空壳堆积。mode 只影响何时写库。 */
  function setDraft(key: string, entry: DraftEntry, mode: DraftPersistMode = 'now'): void {
    const id = String(key)
    bump(id)
    clearedKeys.delete(id)
    if (fileLoading.has(id) && entry.files.length === 0) {
      const meta = metas.get(id)
      if (meta) {
        meta.html = entry.html
        meta.text = entry.text
        meta.quotes = (entry.quotes ?? []).map(quote => ({ ...quote }))
        meta.updatedAt = Date.now()
        if (drafts.value.has(id)) {
          const next = new Map(drafts.value)
          next.delete(id)
          drafts.value = next
        }
        if (isEmptyMeta(meta)) {
          dropMemory(id)
          fileLoading.delete(id)
          schedule(id, 'now')
          return
        }
        schedule(id, mode)
        return
      }
    }
    if (isEmptyDraft(entry)) {
      dropMemory(id)
      fileLoading.delete(id)
      schedule(id, 'now')
      return
    }
    const next = new Map(drafts.value)
    next.set(id, entry)
    drafts.value = next
    schedule(id, mode)
  }

  function clearDraft(key: string): void {
    const id = String(key)
    bump(id)
    dropMemory(id)
    fileLoading.delete(id)
    loadTokens.set(id, (loadTokens.get(id) ?? 0) + 1)
    clearTimer(id)
    schedule(id, 'now')
  }

  function clearDraftAndMark(key: string): void {
    const id = String(key)
    clearDraft(id)
    clearedKeys.add(id)
  }

  /**
   * 边路占位键换成 side:{realSessionId}。先复制再让输入框切键，避免恢复到一条空草稿。
   * 调用方在子组件保存完旧键之后再 clearDraft(from)。
   */
  function rekey(from: string, to: string): void {
    if (from === to) return
    bump(from)
    bump(to)
    const entry = drafts.value.get(from)
    const meta = metas.get(from)
    if (entry) {
      const next = new Map(drafts.value)
      next.set(to, entry)
      drafts.value = next
    }
    if (meta) {
      const moved: DraftMeta = { ...meta, draftKey: to, updatedAt: Date.now(), files: meta.files.map(file => ({ ...file })) }
      metas.set(to, moved)
      lastFiles.set(to, moved.files.map(file => ({ ...file })))
    }
    if (fileLoading.has(from)) {
      fileLoading.delete(from)
      fileLoading.add(to)
      const token = loadTokens.get(from)
      loadTokens.delete(from)
      if (token != null) loadTokens.set(to, token)
    }
    schedule(to, 'now')
  }

  function reset(): void {
    epoch += 1
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    drafts.value = new Map()
    clearedKeys.clear()
    metas.clear()
    lastFiles.clear()
    fileLoading.clear()
    loadTokens.clear()
    generation.clear()
    rerun.clear()
    activeCounts.clear()
    blobSuppressed.clear()
    suppressedFp.clear()
    failedWrites.clear()
    userId = null
  }

  function isCleared(key: string): boolean {
    return clearedKeys.has(String(key))
  }

  async function hydrate(id: number): Promise<void> {
    if (typeof id !== 'number' || !Number.isInteger(id)) return
    userId = id
    if (!isDraftPersistenceEnabled()) return
    if (hydrateInflight) return hydrateInflight
    const run = (async () => {
      try {
        const rows = await getDraftPersistence().loadMetas(id)
        for (const raw of rows) {
          if (!isValidDraftMeta(raw) || raw.userId !== id) continue
          if (drafts.value.has(raw.draftKey) || fileLoading.has(raw.draftKey)) continue
          metas.set(raw.draftKey, {
            ...raw,
            quotes: raw.quotes.map(quote => ({ ...quote })),
            files: raw.files.map(file => ({ ...file })),
          })
          lastFiles.set(raw.draftKey, raw.files.map(file => ({ ...file })))
        }
      } catch (error) {
        console.warn('[draft] hydrate failed', error)
      }
    })()
    hydrateInflight = run.finally(() => { hydrateInflight = null })
    return hydrateInflight
  }

  async function readDraftFiles(key: string, token: number): Promise<RestoredDraftFile[] | null> {
    const id = String(key)
    const meta = metas.get(id)
    if (!meta) return null
    const ids: string[] = []
    for (const file of meta.files) {
      ids.push(file.blobId)
      if (file.originalBlobId) ids.push(file.originalBlobId)
    }
    let blobs: Map<string, Blob>
    try {
      blobs = ids.length > 0 ? await getDraftPersistence().loadBlobs(ids) : new Map()
    } catch (error) {
      console.warn('[draft] load blobs failed', error)
      warnOnce('restore')
      // 不解除的话，输入框会一直拒绝新附件，直到切走这条草稿。
      if (isCurrentLoad(id, token)) cancelFileLoad(id)
      return null
    }
    if (!isCurrentLoad(id, token)) return null
    const restored: RestoredDraftFile[] = []
    let missing = false
    for (const file of meta.files) {
      const item = restoreDraftFile(file, blobs)
      if (!item) {
        missing = true
        continue
      }
      restored.push(item)
    }
    if (missing) {
      warnOnce('restore')
      meta.files = meta.files.filter(file => blobs.has(file.blobId))
      schedule(id, 'now')
    }
    return restored
  }

  function scheduleRetry(key: string): void {
    const count = (failedWrites.get(key) ?? 0) + 1
    if (count > 2) return
    failedWrites.set(key, count)
    clearTimer(key)
    timers.set(key, setTimeout(() => {
      timers.delete(key)
      kick(key)
    }, 1000))
  }

  function schedule(key: string, mode: DraftPersistMode): void {
    if (!canPersist(key)) return
    if (mode === 'debounce') {
      clearTimer(key)
      timers.set(key, setTimeout(() => {
        timers.delete(key)
        kick(key)
      }, DEBOUNCE_MS))
      return
    }
    clearTimer(key)
    kick(key)
  }

  function kick(key: string): void {
    if (!canPersist(key)) return
    if (inflightJobs.has(key)) {
      rerun.add(key)
      return
    }
    const rev = generation.get(key) ?? 0
    const jobEpoch = epoch
    const built = buildWrite(key)
    const job = (async () => {
      let persisted = false
      try {
        if (userId == null) return
        if (!built) {
          await getDraftPersistence().deleteDraft(userId, key)
          persisted = true
        } else {
          persisted = await commitWrite(key, built)
        }
      } catch (error) {
        console.warn('[draft] write failed', error)
      } finally {
        inflightJobs.delete(key)
      }
      if (epoch !== jobEpoch) return
      const changed = (generation.get(key) ?? 0) !== rev || rerun.has(key)
      rerun.delete(key)
      if (!changed) {
        if (persisted) failedWrites.delete(key)
        else scheduleRetry(key)
        return
      }
      const keep = drafts.value.has(key) || (fileLoading.has(key) && metas.has(key))
      if (!keep) {
        metas.delete(key)
        lastFiles.delete(key)
        if (userId != null) {
          try { await getDraftPersistence().deleteDraft(userId, key) } catch { /* 删除已尽力 */ }
        }
        return
      }
      kick(key)
    })()
    inflightJobs.set(key, job)
  }

  function buildWrite(key: string): BuiltWrite | null {
    const uid = userId
    if (uid == null) return null
    const entry = drafts.value.get(key)
    const meta = metas.get(key)
    if (fileLoading.has(key) && meta && !(entry && entry.files.length > 0)) {
      const next: DraftMeta = {
        userId: uid,
        draftKey: key,
        html: entry?.html ?? meta.html,
        text: entry?.text ?? meta.text,
        quotes: (entry?.quotes ?? meta.quotes).map(quote => ({ ...quote })),
        files: meta.files.map(file => ({ ...file })),
        updatedAt: Date.now(),
      }
      if (isEmptyMeta(next)) return null
      return { meta: next, blobs: [], deleteBlobIds: deletesAgainst(key, next.files) }
    }
    if (!entry || isEmptyDraft(entry)) return null
    return applySuppression(key, diffFiles(uid, key, entry))
  }

  function deletesAgainst(key: string, files: DraftFileMeta[]): string[] {
    const keep = new Set<string>()
    for (const file of files) {
      keep.add(file.blobId)
      if (file.originalBlobId) keep.add(file.originalBlobId)
    }
    const deleteBlobIds: string[] = []
    for (const previous of lastFiles.get(key) ?? []) {
      if (!keep.has(previous.blobId)) deleteBlobIds.push(previous.blobId)
      if (previous.originalBlobId && !keep.has(previous.originalBlobId)) deleteBlobIds.push(previous.originalBlobId)
    }
    return deleteBlobIds
  }

  function diffFiles(uid: number, key: string, entry: DraftEntry): BuiltWrite {
    const previous = lastFiles.get(key) ?? []
    const files: DraftFileMeta[] = []
    const blobs: BlobPut[] = []
    entry.files.forEach((item, index) => {
      const slot = previous[index]
      if (slot && fileFingerprint(item) === metaFingerprint(slot)) {
        files.push({ ...slot })
        return
      }
      const blobId = generateUUID()
      blobs.push({ blobId, userId: uid, draftKey: key, blob: item.file })
      const fileMeta: DraftFileMeta = {
        blobId,
        name: item.file.name,
        type: item.file.type,
        size: item.file.size,
        lastModified: item.file.lastModified,
        localPath: item.localPath ?? '',
      }
      if (item.originalFile && item.originalFile !== item.file) {
        const originalBlobId = generateUUID()
        blobs.push({ blobId: originalBlobId, userId: uid, draftKey: key, blob: item.originalFile })
        fileMeta.originalBlobId = originalBlobId
        fileMeta.originalName = item.originalFile.name
        fileMeta.originalType = item.originalFile.type
        fileMeta.originalSize = item.originalFile.size
        fileMeta.originalLastModified = item.originalFile.lastModified
      }
      files.push(fileMeta)
    })
    const meta: DraftMeta = {
      userId: uid,
      draftKey: key,
      html: entry.html,
      text: entry.text,
      quotes: (entry.quotes ?? []).map(quote => ({ ...quote })),
      files,
      updatedAt: Date.now(),
    }
    return { meta, blobs, deleteBlobIds: deletesAgainst(key, files) }
  }

  function applySuppression(key: string, built: BuiltWrite): BuiltWrite {
    if (!blobSuppressed.has(key)) return built
    const entry = drafts.value.get(key)
    const fingerprint = entry ? filesFingerprint(entry) : ''
    if (fingerprint && fingerprint !== suppressedFp.get(key)) {
      blobSuppressed.delete(key)
      suppressedFp.delete(key)
      return built
    }
    return stripFiles(key, built)
  }

  function stripFiles(key: string, built: BuiltWrite): BuiltWrite {
    const deleteBlobIds = new Set<string>(built.deleteBlobIds)
    for (const file of built.meta.files) {
      deleteBlobIds.add(file.blobId)
      if (file.originalBlobId) deleteBlobIds.add(file.originalBlobId)
    }
    for (const file of lastFiles.get(key) ?? []) {
      deleteBlobIds.add(file.blobId)
      if (file.originalBlobId) deleteBlobIds.add(file.originalBlobId)
    }
    return {
      meta: { ...built.meta, files: [] },
      blobs: [],
      deleteBlobIds: [...deleteBlobIds],
    }
  }

  function markSuppressed(key: string): void {
    const entry = drafts.value.get(key)
    blobSuppressed.add(key)
    suppressedFp.set(key, entry ? filesFingerprint(entry) : '')
  }

  async function commitWrite(key: string, built: BuiltWrite): Promise<boolean> {
    const uid = userId
    if (uid == null) return false
    let payload = built
    if (payload.blobs.length > 0 && listedBytes(payload.meta.files) > maxBytes) {
      warnOnce('save')
      markSuppressed(key)
      payload = stripFiles(key, payload)
    }
    const persistence = getDraftPersistence()
    if (await tryWrite(persistence, payload)) {
      remember(key, payload.meta)
      await trim(uid, protectSet(key))
      return true
    }
    const victim = await oldestUnprotected(uid, protectSet(key))
    if (victim && victim.draftKey !== key) {
      await persistence.deleteDraft(uid, victim.draftKey)
      dropMemory(victim.draftKey)
    }
    if (await tryWrite(persistence, payload)) {
      remember(key, payload.meta)
      await trim(uid, protectSet(key))
      return true
    }
    if (payload.blobs.length > 0 || payload.meta.files.length > 0) {
      warnOnce('save')
      markSuppressed(key)
      payload = stripFiles(key, payload)
      if (await tryWrite(persistence, payload)) {
        remember(key, payload.meta)
        return true
      }
    }
    return false
  }

  async function tryWrite(persistence: DraftPersistence, payload: BuiltWrite): Promise<boolean> {
    try {
      await persistence.writeMeta(payload.meta, payload.blobs, payload.deleteBlobIds)
      return true
    } catch (error) {
      console.warn('[draft] write failed', error)
      return false
    }
  }

  function remember(key: string, meta: DraftMeta): void {
    const stored = { ...meta, quotes: meta.quotes.map(quote => ({ ...quote })), files: meta.files.map(file => ({ ...file })) }
    metas.set(key, stored)
    lastFiles.set(key, stored.files.map(file => ({ ...file })))
  }

  async function oldestUnprotected(uid: number, protectedKeys: Set<string>): Promise<DraftMeta | null> {
    const rows = (await getDraftPersistence().loadMetas(uid)).filter(isValidDraftMeta)
    rows.sort((a, b) => a.updatedAt - b.updatedAt)
    return rows.find(row => !protectedKeys.has(row.draftKey)) ?? null
  }

  async function trim(uid: number, protectedKeys: Set<string>): Promise<void> {
    for (let guard = 0; guard < 100; guard += 1) {
      const rows = (await getDraftPersistence().loadMetas(uid)).filter(isValidDraftMeta)
      const bytes = rows.reduce((sum, row) => sum + listedBytes(row.files), 0)
      if (rows.length <= maxDrafts && bytes <= maxBytes) return
      const victim = [...rows].sort((a, b) => a.updatedAt - b.updatedAt).find(row => !protectedKeys.has(row.draftKey))
      if (!victim) return
      await getDraftPersistence().deleteDraft(uid, victim.draftKey)
      dropMemory(victim.draftKey)
    }
  }

  async function drain(): Promise<void> {
    for (let guard = 0; guard < 30; guard += 1) {
      if (inflightJobs.size === 0) return
      await Promise.all([...inflightJobs.values()])
    }
  }

  function flushPending(): void {
    // 只冲刷本页改过的键。把 hydrate 进来、还没打开的 meta 也 kick 一遍，
    // buildWrite 会当成空条目并把库里的草稿删掉。
    const keys = new Set<string>([...timers.keys(), ...drafts.value.keys(), ...fileLoading])
    for (const key of keys) {
      clearTimer(key)
      kick(key)
    }
  }

  async function flushAll(): Promise<void> {
    flushPending()
    await drain()
  }

  flushHandler = () => { flushPending() }

  return {
    drafts,
    getDraft,
    getDraftMeta,
    setDraft,
    hasDraft,
    clearDraft,
    clearDraftAndMark,
    rekey,
    reset,
    isCleared,
    hydrate,
    flushAll,
    isFileLoading,
    isCurrentLoad,
    startFileLoad,
    cancelFileLoad,
    finishFileLoad,
    activateDraftKey,
    deactivateDraftKey,
    readDraftFiles,
  }
})
