import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDraftStore, type DraftEntry, setDraftLimitsForTests } from './draft'
import { createMemoryDraftPersistence, resetDraftPersistence, setDraftPersistence } from './draft-persist'

function makeEntry(text: string, fileCount = 0): DraftEntry {
  return {
    html: `<p>${text}</p>`,
    text,
    files: fileCount > 0
      ? Array.from({ length: fileCount }, (_, i) => ({
          file: new File(['x'], `f${i}.txt`),
          previewUrl: i === 0 ? 'blob:preview' : '',
        }))
      : [],
  }
}

describe('draft store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('set 后 get 返回同一草稿', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('你好'))
    expect(store.hasDraft('s:1')).toBe(true)
    expect(store.getDraft('s:1')?.text).toBe('你好')
    expect(store.getDraft('s:1')?.files.length).toBe(0)
  })

  it('只有回复引用时不算空草稿', () => {
    const store = useDraftStore()
    store.setDraft('s:1', {
      html: '<p></p>',
      text: '',
      files: [],
      quotes: [{ id: 'q1', text: '引用的回复', truncated: false }],
    })
    expect(store.hasDraft('s:1')).toBe(true)
    expect(store.getDraft('s:1')?.quotes).toEqual([{ id: 'q1', text: '引用的回复', truncated: false }])
  })

  it('空内容写入时删除条目而非存储空壳', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('草稿'))
    store.setDraft('s:1', makeEntry('   '))
    expect(store.hasDraft('s:1')).toBe(false)
    store.setDraft('s:2', makeEntry('', 1))
    expect(store.hasDraft('s:2')).toBe(true)
  })

  it('仅剩空文档 HTML 结构时也视为空内容', () => {
    const store = useDraftStore()
    store.setDraft('s:1', { html: '<p></p>', text: '', files: [] })
    expect(store.hasDraft('s:1')).toBe(false)
  })

  it('clearDraft 仅删条目不标记：发送成功后重新输入可再次保存', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    // 发送成功清除
    store.clearDraft('s:1')
    expect(store.hasDraft('s:1')).toBe(false)
    expect(store.isCleared('s:1')).toBe(false)
    // 用户重新输入后切走会话，可再次保存
    store.setDraft('s:1', makeEntry('b'))
    expect(store.isCleared('s:1')).toBe(false)
    expect(store.getDraft('s:1')?.text).toBe('b')
  })

  it('clearDraftAndMark 删除条目并标记，晚到的兜底保存不再写回', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    // 删除会话
    store.clearDraftAndMark('s:1')
    expect(store.hasDraft('s:1')).toBe(false)
    expect(store.isCleared('s:1')).toBe(true)
    // 模拟 saveDraft 的防复活检查：isCleared 时跳过写入
    const saved = !store.isCleared('s:1')
    if (saved) store.setDraft('s:1', makeEntry('b'))
    expect(store.hasDraft('s:1')).toBe(false)
  })

  it('reset 同时清空清除标记', () => {
    const store = useDraftStore()
    store.clearDraftAndMark('s:1')
    store.reset()
    expect(store.isCleared('s:1')).toBe(false)
  })

  it('clearDraft 清除指定键且不影响其他键', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    store.setDraft('s:2', makeEntry('b'))
    store.clearDraft('s:1')
    expect(store.hasDraft('s:1')).toBe(false)
    expect(store.getDraft('s:2')?.text).toBe('b')
  })

  it('reset 清空全部草稿', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    store.setDraft('new', makeEntry('b'))
    store.reset()
    expect(store.drafts.size).toBe(0)
  })

  it('File 对象引用在存取间保留（不序列化）', () => {
    const store = useDraftStore()
    const entry = makeEntry('带附件', 2)
    store.setDraft('side:9', entry)
    const restored = store.getDraft('side:9')
    expect(restored?.files[0]?.file).toBe(entry.files[0]?.file)
    expect(restored?.files[0]?.previewUrl).toBe('blob:preview')
  })

  it('键统一按字符串处理', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    expect(store.getDraft('s:1')?.text).toBe('a')
  })
})

describe('draft store 持久化', () => {
  afterEach(() => {
    resetDraftPersistence()
    setDraftLimitsForTests(null)
  })

  it('hydrate 不覆盖已经在内存里的条目', async () => {
    const persistence = createMemoryDraftPersistence()
    setDraftPersistence(persistence)
    const store = useDraftStore()
    await persistence.writeMeta({
      userId: 1,
      draftKey: 's:1',
      html: '<p>disk</p>',
      text: 'disk',
      quotes: [],
      files: [],
      updatedAt: 1,
    }, [], [])
    store.setDraft('s:1', makeEntry('memory'))
    await store.hydrate(1)
    expect(store.getDraft('s:1')?.text).toBe('memory')
  })

  it('clearDraft 发生在写入开始之后，最终库里没有该键', async () => {
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
    store.setDraft('s:1', makeEntry('晚到'))
    store.clearDraft('s:1')
    gate.release()
    await store.flushAll()
    expect(await persistence.loadMetas(1)).toEqual([])
    expect(store.hasDraft('s:1')).toBe(false)
  })
})
