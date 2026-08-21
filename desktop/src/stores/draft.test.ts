import { beforeEach, describe, expect, it } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDraftStore, type DraftEntry } from './draft'

function makeEntry(text: string, fileCount = 0): DraftEntry {
  return {
    html: `<p>${text}</p>`,
    text,
    files: fileCount > 0
      ? Array.from({ length: fileCount }, (_, i) => new File(['x'], `f${i}.txt`))
      : [],
    filePreviewUrls: fileCount > 0 ? Array.from({ length: fileCount }, (_, i) => (i === 0 ? 'blob:preview' : '')) : [],
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
    store.setDraft('s:1', { html: '<p></p>', text: '', files: [], filePreviewUrls: [] })
    expect(store.hasDraft('s:1')).toBe(false)
  })

  it('clearDraft 后标记已清除，重新写入后解除标记', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    store.clearDraft('s:1')
    expect(store.isCleared('s:1')).toBe(true)
    store.setDraft('s:1', makeEntry('b'))
    expect(store.isCleared('s:1')).toBe(false)
    expect(store.getDraft('s:1')?.text).toBe('b')
  })

  it('reset 同时清空清除标记', () => {
    const store = useDraftStore()
    store.clearDraft('s:1')
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
    expect(restored?.files[0]).toBe(entry.files[0])
    expect(restored?.filePreviewUrls[0]).toBe('blob:preview')
  })

  it('键统一按字符串处理', () => {
    const store = useDraftStore()
    store.setDraft('s:1', makeEntry('a'))
    expect(store.getDraft('s:1')?.text).toBe('a')
  })
})
