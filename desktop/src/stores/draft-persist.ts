/**
 * 输入草稿的本机 IndexedDB。内存 Map 仍是当前页的同步来源，这里只负责刷新之后还能读回来。
 * 单测注入 createMemoryDraftPersistence；Node 里没有 indexedDB 时用空实现，避免启动定时器。
 */

export interface DraftFileMeta {
  blobId: string
  name: string
  type: string
  size: number
  lastModified: number
  localPath: string
  originalBlobId?: string
  originalName?: string
  originalType?: string
  originalSize?: number
  originalLastModified?: number
}

export interface DraftMeta {
  userId: number
  draftKey: string
  html: string
  text: string
  quotes: Array<{ id: string; text: string; truncated: boolean }>
  files: DraftFileMeta[]
  updatedAt: number
}

export interface BlobPut {
  blobId: string
  userId: number
  draftKey: string
  blob: Blob
}

export interface DraftPersistence {
  readonly enabled: boolean
  loadMetas(userId: number): Promise<DraftMeta[]>
  loadBlobs(ids: string[]): Promise<Map<string, Blob>>
  writeMeta(meta: DraftMeta, blobs: BlobPut[], deleteBlobIds: string[]): Promise<void>
  deleteDraft(userId: number, draftKey: string): Promise<void>
  deleteUser(userId: number): Promise<void>
}

export interface MemoryDraftPersistence extends DraftPersistence {
  writes: Array<{ meta: DraftMeta; blobs: BlobPut[]; deleteBlobIds: string[] }>
}

const DB_NAME = 'mao-drafts'
const DB_VERSION = 1

interface BlobRecord {
  blobId: string
  userId: number
  draftKey: string
  blob: Blob
}

// 声明必须先于 active 的初始化：createDefaultPersistence() 在浏览器里会同步走
// openDatabase() 读这两个变量，若排在 let active 之后即命中 TDZ
// （"Cannot access 'database' before initialization"），整个模块求值崩溃、应用白屏。
// Node 单测里 indexedDB 未定义、早退 noop，所以此前只在真实浏览器暴露。
let database: IDBDatabase | null = null
let opening: Promise<IDBDatabase> | null = null
let active: DraftPersistence = createDefaultPersistence()

export function getDraftPersistence(): DraftPersistence {
  return active
}

export function setDraftPersistence(next: DraftPersistence): void {
  active = next
}

export function resetDraftPersistence(): void {
  active = createDefaultPersistence()
}

export function isDraftPersistenceEnabled(): boolean {
  return active.enabled
}

function createDefaultPersistence(): DraftPersistence {
  if (typeof indexedDB === 'undefined') return createNoopPersistence()
  const persistence = createIndexedDbPersistence()
  void openDatabase().catch(() => {})
  return persistence
}

export function createNoopPersistence(): DraftPersistence {
  return {
    enabled: false,
    async loadMetas() { return [] },
    async loadBlobs() { return new Map() },
    async writeMeta() {},
    async deleteDraft() {},
    async deleteUser() {},
  }
}

export function createMemoryDraftPersistence(hooks?: {
  beforeWrite?: () => Promise<void> | void
  /** 前几次 writeMeta 抛 QuotaExceededError，用来走裁剪重试 */
  failTimes?: { count: number }
}): MemoryDraftPersistence {
  const metas = new Map<string, DraftMeta>()
  const blobs = new Map<string, BlobRecord>()
  const writes: MemoryDraftPersistence['writes'] = []
  const keyOf = (userId: number, draftKey: string) => `${userId}\0${draftKey}`

  return {
    enabled: true,
    writes,
    async loadMetas(userId) {
      return [...metas.values()].filter(meta => meta.userId === userId).map(cloneMeta)
    },
    async loadBlobs(ids) {
      const out = new Map<string, Blob>()
      for (const id of ids) {
        const record = blobs.get(id)
        if (record) out.set(id, record.blob)
      }
      return out
    },
    async writeMeta(meta, puts, deleteBlobIds) {
      await hooks?.beforeWrite?.()
      if (hooks?.failTimes && hooks.failTimes.count > 0) {
        hooks.failTimes.count -= 1
        throw new DOMException('quota', 'QuotaExceededError')
      }
      writes.push({ meta: cloneMeta(meta), blobs: puts.map(put => ({ ...put })), deleteBlobIds: [...deleteBlobIds] })
      for (const id of deleteBlobIds) blobs.delete(id)
      metas.set(keyOf(meta.userId, meta.draftKey), cloneMeta(meta))
      for (const put of puts) {
        blobs.set(put.blobId, { blobId: put.blobId, userId: put.userId, draftKey: put.draftKey, blob: put.blob })
      }
    },
    async deleteDraft(userId, draftKey) {
      metas.delete(keyOf(userId, draftKey))
      for (const [id, record] of blobs) {
        if (record.userId === userId && record.draftKey === draftKey) blobs.delete(id)
      }
    },
    async deleteUser(userId) {
      for (const meta of [...metas.values()]) {
        if (meta.userId === userId) metas.delete(keyOf(userId, meta.draftKey))
      }
      for (const [id, record] of blobs) {
        if (record.userId === userId) blobs.delete(id)
      }
    },
  }
}

function cloneMeta(meta: DraftMeta): DraftMeta {
  return {
    ...meta,
    quotes: meta.quotes.map(quote => ({ ...quote })),
    files: meta.files.map(file => ({ ...file })),
  }
}

/** 读回若不是带类型的 File，用 meta 的名字和类型包一层，上传文件名才不会丢。 */
export function blobToFile(
  blob: Blob,
  desc: { name: string; type: string; lastModified: number },
): File {
  if (typeof File !== 'undefined' && blob instanceof File && blob.type) return blob
  return new File([blob], desc.name, {
    type: desc.type,
    lastModified: desc.lastModified || Date.now(),
  })
}

/** 图片预览只来自恢复后的新对象 URL，不复用入库前的 blob: 字符串。 */
export function previewUrlForRestoredFile(
  file: File,
  createObjectURL: (file: File) => string = URL.createObjectURL,
): string {
  if (!file.type.startsWith('image/')) return ''
  return createObjectURL(file)
}

export function restoreDraftFile(
  meta: DraftFileMeta,
  blobs: Map<string, Blob>,
): { file: File; originalFile: File; localPath: string } | null {
  const current = blobs.get(meta.blobId)
  if (!current) return null
  const file = blobToFile(current, meta)
  let originalFile = file
  if (meta.originalBlobId) {
    const original = blobs.get(meta.originalBlobId)
    if (original) {
      originalFile = blobToFile(original, {
        name: meta.originalName || meta.name,
        type: meta.originalType || meta.type,
        lastModified: meta.originalLastModified || meta.lastModified,
      })
    }
  }
  return { file, originalFile, localPath: meta.localPath || '' }
}

export function isValidDraftMeta(raw: unknown): raw is DraftMeta {
  if (!raw || typeof raw !== 'object') return false
  const meta = raw as DraftMeta
  if (typeof meta.userId !== 'number' || !Number.isInteger(meta.userId)) return false
  if (typeof meta.draftKey !== 'string' || typeof meta.html !== 'string' || typeof meta.text !== 'string') return false
  if (typeof meta.updatedAt !== 'number' || !Array.isArray(meta.quotes) || !Array.isArray(meta.files)) return false
  return meta.files.every(file =>
    !!file
    && typeof file.blobId === 'string'
    && typeof file.name === 'string'
    && typeof file.type === 'string'
    && typeof file.size === 'number'
    && typeof file.localPath === 'string',
  )
}

function createIndexedDbPersistence(): DraftPersistence {
  return {
    enabled: true,
    loadMetas: loadMetasFromDb,
    loadBlobs: loadBlobsFromDb,
    writeMeta: (meta, blobs, deleteBlobIds) => withDatabase(db => writeMetaOn(db, meta, blobs, deleteBlobIds)),
    deleteDraft: (userId, draftKey) => withDatabase(db => deleteDraftOn(db, userId, draftKey)),
    deleteUser: (userId) => withDatabase(db => deleteUserOn(db, userId)),
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (database) return Promise.resolve(database)
  if (opening) return opening
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('metas')) {
        const metas = db.createObjectStore('metas', { keyPath: ['userId', 'draftKey'] })
        metas.createIndex('byUser', 'userId', { unique: false })
      }
      if (!db.objectStoreNames.contains('blobs')) {
        const blobs = db.createObjectStore('blobs', { keyPath: 'blobId' })
        blobs.createIndex('byOwner', ['userId', 'draftKey'], { unique: false })
      }
    }
    request.onsuccess = () => {
      database = request.result
      database.onversionchange = () => {
        database?.close()
        database = null
      }
      resolve(database)
    }
    request.onerror = () => {
      opening = null
      reject(request.error ?? new Error('indexedDB open failed'))
    }
  })
  return opening
}

function withDatabase<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  if (database) return run(database)
  return openDatabase().then(run)
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
  })
}

async function loadMetasFromDb(userId: number): Promise<DraftMeta[]> {
  const db = await openDatabase()
  const tx = db.transaction('metas', 'readonly')
  const request = tx.objectStore('metas').index('byUser').getAll(userId)
  const rows = await requestResult<DraftMeta[]>(request)
  await transactionDone(tx)
  return rows ?? []
}

function loadBlobsFromDb(ids: string[]): Promise<Map<string, Blob>> {
  return withDatabase(db => new Promise((resolve, reject) => {
    const tx = db.transaction('blobs', 'readonly')
    const store = tx.objectStore('blobs')
    const out = new Map<string, Blob>()
    for (const id of ids) {
      const request = store.get(id)
      request.onsuccess = () => {
        const record = request.result as BlobRecord | undefined
        if (record?.blob) out.set(id, record.blob)
      }
    }
    tx.oncomplete = () => resolve(out)
    tx.onerror = () => reject(tx.error ?? new Error('indexedDB read failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexedDB read aborted'))
  }))
}

function writeMetaOn(db: IDBDatabase, meta: DraftMeta, puts: BlobPut[], deleteBlobIds: string[]): Promise<void> {
  const tx = db.transaction(['metas', 'blobs'], 'readwrite')
  const metas = tx.objectStore('metas')
  const blobs = tx.objectStore('blobs')
  metas.put(meta)
  for (const id of deleteBlobIds) blobs.delete(id)
  for (const put of puts) {
    const record: BlobRecord = { blobId: put.blobId, userId: put.userId, draftKey: put.draftKey, blob: put.blob }
    blobs.put(record)
  }
  return transactionDone(tx)
}

function deleteDraftOn(db: IDBDatabase, userId: number, draftKey: string): Promise<void> {
  const tx = db.transaction(['metas', 'blobs'], 'readwrite')
  const metas = tx.objectStore('metas')
  const blobs = tx.objectStore('blobs')
  metas.delete([userId, draftKey])
  const request = blobs.index('byOwner').getAll([userId, draftKey])
  request.onsuccess = () => {
    const records = (request.result ?? []) as BlobRecord[]
    for (const record of records) blobs.delete(record.blobId)
  }
  return transactionDone(tx)
}

function deleteUserOn(db: IDBDatabase, userId: number): Promise<void> {
  const tx = db.transaction(['metas', 'blobs'], 'readwrite')
  const metas = tx.objectStore('metas')
  const blobs = tx.objectStore('blobs')
  const request = metas.index('byUser').getAll(userId)
  request.onsuccess = () => {
    const rows = (request.result ?? []) as DraftMeta[]
    for (const meta of rows) metas.delete([userId, meta.draftKey])
    // 同一事务里按 userId 前缀扫掉字节，避免在循环里再挂 getAll、事务先结束留下孤儿。
    const range = IDBKeyRange.bound([userId, ''], [userId, '\uffff'])
    const cursorRequest = blobs.index('byOwner').openCursor(range)
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) return
      cursor.delete()
      cursor.continue()
    }
  }
  return transactionDone(tx)
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'))
  })
}
