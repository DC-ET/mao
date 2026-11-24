import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setDraftLimitsForTests, useDraftStore, type DraftEntry } from './draft'
import {
  blobToFile,
  createMemoryDraftPersistence,
  previewUrlForRestoredFile,
  resetDraftPersistence,
  restoreDraftFile,
  setDraftPersistence,
  type DraftMeta,
} from './draft-persist'

function textMeta(userId: number, draftKey: string, text: string, updatedAt: number, files: DraftMeta['files'] = []): DraftMeta {
  return {
    userId,
    draftKey,
    html: `<p>${text}</p>`,
    text,
    quotes: [],
    files,
    updatedAt,
  }
}

function entry(text: string, files: DraftEntry['files'] = []): DraftEntry {
  return { html: `<p>${text}</p>`, text, files }
}

describe('草稿字节恢复', () => {
  it('Blob 用 meta 的名字和类型包回 File', () => {
    const blob = new Blob(['hello'], { type: '' })
    const file = blobToFile(blob, { name: 'pasted.txt', type: 'text/plain', lastModified: 42 })
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('pasted.txt')
    expect(file.type).toBe('text/plain')
    expect(file.lastModified).toBe(42)
  })

  it('已经带类型的 File 保持原对象', () => {
    const original = new File(['x'], 'a.png', { type: 'image/png' })
    expect(blobToFile(original, { name: 'other.png', type: 'image/jpeg', lastModified: 1 })).toBe(original)
  })

  it('图片预览 URL 来自对新 File 的 createObjectURL，非图片为空', () => {
    const image = new File(['x'], 'a.png', { type: 'image/png' })
    const text = new File(['x'], 'a.txt', { type: 'text/plain' })
    const createObjectURL = vi.fn(() => 'blob:fresh')
    expect(previewUrlForRestoredFile(image, createObjectURL)).toBe('blob:fresh')
    expect(createObjectURL).toHaveBeenCalledWith(image)
    expect(previewUrlForRestoredFile(text, createObjectURL)).toBe('')
  })

  it('没有原图 blob 时 originalFile 与 file 是同一引用', () => {
    const file = new File(['x'], 'a.png', { type: 'image/png' })
    const restored = restoreDraftFile({
      blobId: 'b1',
      name: 'a.png',
      type: 'image/png',
      size: file.size,
      lastModified: file.lastModified,
      localPath: '',
    }, new Map([['b1', file]]))
    expect(restored?.file).toBe(file)
    expect(restored?.originalFile).toBe(file)
  })
})

describe('草稿落库调度', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    resetDraftPersistence()
    setDraftLimitsForTests(null)
    vi.useRealTimers()
  })

  it('文字防抖未到时 flush 写入最新 HTML', async () => {
    vi.useFakeTimers()
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    store.setDraft('s:1', entry('先'), 'debounce')
    store.setDraft('s:1', entry('后'), 'debounce')
    expect(persistence.writes).toHaveLength(0)
    await store.flushAll()
    expect((await persistence.loadMetas(1))[0]?.text).toBe('后')
  })

  it('旧写入后返回时，库里留下较新的内容', async () => {
    const gate: { release: () => void } = { release: () => {} }
    let held = false
    const persistence = createMemoryDraftPersistence({
      beforeWrite: () => {
        if (held) return
        held = true
        return new Promise<void>(resolve => { gate.release = () => resolve() })
      },
    })
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    store.setDraft('s:1', entry('旧'))
    store.setDraft('s:1', entry('新'))
    gate.release()
    await store.flushAll()
    expect((await persistence.loadMetas(1)).map(meta => meta.text)).toEqual(['新'])
  })

  it('用户之间互不可见，deleteUser 只删一个人', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    await persistence.writeMeta(textMeta(1, 's:1', '甲', 1), [], [])
    await persistence.writeMeta(textMeta(2, 's:1', '乙', 2), [], [])
    const store = useDraftStore()
    await store.hydrate(1)
    expect(store.getDraftMeta('s:1')?.text).toBe('甲')
    await persistence.deleteUser(1)
    expect(await persistence.loadMetas(1)).toEqual([])
    expect((await persistence.loadMetas(2))[0]?.text).toBe('乙')
  })

  it('附件指纹不变时不重写字节；标注替换会换 blob 并删掉旧的', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    const original = new File(['orig'], 'shot.png', { type: 'image/png', lastModified: 10 })
    store.setDraft('s:1', entry('图', [{ file: original, previewUrl: 'blob:old', originalFile: original }]))
    await store.flushAll()
    store.setDraft('s:1', entry('改字', [{ file: original, previewUrl: 'blob:old', originalFile: original }]))
    await store.flushAll()
    expect(persistence.writes.at(-1)?.blobs).toHaveLength(0)
    const keptId = (await persistence.loadMetas(1))[0]?.files[0]?.blobId
    const annotated = new File(['mark'], 'shot-annotated.png', { type: 'image/png', lastModified: 11 })
    store.setDraft('s:1', entry('标', [{ file: annotated, previewUrl: '', originalFile: original }]))
    await store.flushAll()
    expect(persistence.writes.some(write => write.blobs.length === 2)).toBe(true)
    expect(persistence.writes.some(write => write.deleteBlobIds.includes(keptId!))).toBe(true)
    const saved = (await persistence.loadMetas(1))[0]
    expect(saved?.files[0]?.originalBlobId).toBeTruthy()
    const blobs = await persistence.loadBlobs([
      saved!.files[0]!.blobId,
      saved!.files[0]!.originalBlobId!,
    ])
    const restored = restoreDraftFile(saved!.files[0]!, blobs)
    expect(restored?.file.name).toBe('shot-annotated.png')
    expect(restored?.originalFile).not.toBe(restored?.file)
  })

  it('只 hydrate 了 meta 时，第一次改字也不重写 blob', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const file = new File(['x'], 'a.png', { type: 'image/png', lastModified: 5 })
    const meta = textMeta(1, 's:1', 'a', 1, [{
      blobId: 'b1',
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      localPath: '',
    }])
    await persistence.writeMeta(meta, [{ blobId: 'b1', userId: 1, draftKey: 's:1', blob: file }], [])
    const store = useDraftStore()
    await store.hydrate(1)
    const token = store.startFileLoad('s:1')
    store.setDraft('s:1', entry('b'), 'now')
    await store.flushAll()
    expect(persistence.writes.at(-1)?.blobs).toHaveLength(0)
    expect((await persistence.loadMetas(1))[0]?.files).toHaveLength(1)
    expect((await persistence.loadMetas(1))[0]?.text).toBe('b')
    const restored = await store.readDraftFiles('s:1', token)
    expect(restored?.[0]?.file.name).toBe('a.png')
    expect(restored?.[0]?.originalFile).toBe(restored?.[0]?.file)
  })

  it('第 31 条会删掉最旧且不是当前键、也不是正在恢复的那条', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    for (let index = 0; index < 30; index += 1) {
      await persistence.writeMeta(textMeta(1, `s:${index}`, '旧', index + 1), [], [])
    }
    const store = useDraftStore()
    await store.hydrate(1)
    store.startFileLoad('s:0')
    store.setDraft('s:new', entry('新'))
    await store.flushAll()
    const keys = (await persistence.loadMetas(1)).map(meta => meta.draftKey)
    expect(keys).toContain('s:new')
    expect(keys).toContain('s:0')
    expect(keys).not.toContain('s:1')
    expect(keys).toHaveLength(30)
  })

  it('单条超过字节上限时只留文字，当前页内存里的文件还在', async () => {
    setDraftLimitsForTests({ maxDrafts: 30, maxBytes: 4 })
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    const big = new File([new Uint8Array(8)], 'big.bin', { type: 'application/octet-stream' })
    store.setDraft('s:1', entry('大', [{ file: big, previewUrl: '' }]))
    await store.flushAll()
    expect((await persistence.loadMetas(1))[0]?.files).toEqual([])
    expect(store.getDraft('s:1')?.files).toHaveLength(1)
    store.setDraft('s:1', entry('再改', [{ file: big, previewUrl: '' }]))
    await store.flushAll()
    expect(persistence.writes.at(-1)?.blobs).toHaveLength(0)
  })

  it('连续两次写库失败后退回只留文字，并删掉一条最旧草稿', async () => {
    const failTimes = { count: 0 }
    const persistence = createMemoryDraftPersistence({ failTimes })
    setDraftPersistence(persistence)
    await persistence.writeMeta(textMeta(1, 's:old', '旧', 1), [], [])
    failTimes.count = 2
    const store = useDraftStore()
    await store.hydrate(1)
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    store.setDraft('s:1', entry('新', [{ file, previewUrl: '' }]))
    await store.flushAll()
    const metas = await persistence.loadMetas(1)
    expect(metas.map(meta => meta.draftKey)).toEqual(['s:1'])
    expect(metas[0]?.files).toEqual([])
    expect(store.getDraft('s:1')?.files).toHaveLength(1)
  })

  it('空草稿不留记录；只有引用或文件时保留', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    store.setDraft('s:1', { html: '<p></p>', text: '   ', files: [] })
    await store.flushAll()
    expect(await persistence.loadMetas(1)).toEqual([])
    store.setDraft('s:2', { html: '<p></p>', text: '', files: [], quotes: [{ id: 'q', text: '引用', truncated: false }] })
    await store.flushAll()
    expect((await persistence.loadMetas(1)).map(meta => meta.draftKey)).toEqual(['s:2'])
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })
    store.setDraft('s:2', { html: '<p></p>', text: '', files: [], quotes: [] })
    store.setDraft('s:3', entry('', [{ file, previewUrl: '' }]))
    await store.flushAll()
    const keys = (await persistence.loadMetas(1)).map(meta => meta.draftKey).sort()
    expect(keys).toEqual(['s:3'])
  })

  it('读附件失败后解除 filesLoading，输入框可以再添加附件', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence({
      ...persistence,
      async loadBlobs() {
        throw new Error('idb read failed')
      },
    })
    const file = new File(['x'], 'a.png', { type: 'image/png', lastModified: 5 })
    await persistence.writeMeta(textMeta(1, 's:1', 'a', 1, [{
      blobId: 'b1',
      name: file.name,
      type: file.type,
      size: file.size,
      lastModified: file.lastModified,
      localPath: '',
    }]), [{ blobId: 'b1', userId: 1, draftKey: 's:1', blob: file }], [])
    const store = useDraftStore()
    await store.hydrate(1)
    const token = store.startFileLoad('s:1')
    expect(await store.readDraftFiles('s:1', token)).toBeNull()
    expect(store.isFileLoading('s:1')).toBe(false)
  })

  it('占位边路键不落库，转正后只留下 side:{id}', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await store.hydrate(1)
    store.setDraft('side:0', entry('占位'))
    await store.flushAll()
    expect(persistence.writes).toHaveLength(0)
    store.rekey('side:0', 'side:42')
    await store.flushAll()
    store.clearDraft('side:0')
    await store.flushAll()
    expect((await persistence.loadMetas(1)).map(meta => meta.draftKey)).toEqual(['side:42'])
    expect(store.getDraft('side:42')?.text).toBe('占位')
    expect(store.hasDraft('side:0')).toBe(false)
  })
})
