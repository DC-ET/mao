/**
 * @vitest-environment jsdom
 *
 * 文件预览重载有 300ms 去抖。去抖期间编辑器里仍是旧内容，
 * 修订号却已经变大。这时引用应配得上屏幕上的那一版。
 */
import { nextTick, h } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileRangeQuotePayload } from '../../utils/selection-quote'

const harness = vi.hoisted(() => {
  if (typeof window !== 'undefined' && !window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return false },
    })) as unknown as typeof window.matchMedia
  }
  return {
    host: null as HTMLElement | null,
    refreshSelection: null as null | (() => void),
  }
})

vi.mock('./PdfViewer.vue', () => ({ default: { name: 'PdfViewer', render: () => null } }))
vi.mock('./CsvTableView.vue', () => ({ default: { name: 'CsvTableView', render: () => null } }))
vi.mock('./ArchiveBrowser.vue', () => ({ default: { name: 'ArchiveBrowser', render: () => null } }))
vi.mock('./SpreadsheetView.vue', () => ({ default: { name: 'SpreadsheetView', render: () => null } }))
vi.mock('./DocxPreview.vue', () => ({ default: { name: 'DocxPreview', render: () => null } }))
vi.mock('./MediaPlayer.vue', () => ({ default: { name: 'MediaPlayer', render: () => null } }))
vi.mock('../common/MarkdownContent.vue', () => ({ default: { name: 'MarkdownContent', render: () => null } }))

vi.mock('../../composables/useMonacoViewer', () => ({
  useMonacoViewer(options: { onEditor?: (editor: unknown) => void }) {
    options.onEditor?.({
      getDomNode: () => harness.host,
      addAction: () => ({ dispose() {} }),
      onDidChangeCursorSelection(cb: () => void) {
        harness.refreshSelection = cb
        return { dispose() {} }
      },
      onDidScrollChange: () => ({ dispose() {} }),
      onDidChangeModelContent: () => ({ dispose() {} }),
      getModel: () => ({
        getLineCount: () => 1,
        getLineContent: () => 'print("old")',
        getLanguageId: () => 'python',
      }),
      getSelection: () => ({
        isEmpty: () => false,
        startLineNumber: 1,
        endLineNumber: 1,
        endColumn: 12,
      }),
      getScrolledVisiblePosition: () => ({ top: 40, left: 8, height: 20 }),
    })
  },
}))

import FileViewer from './FileViewer.vue'
import { useSessionStore } from '../../stores/session'

function mountViewer() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = useSessionStore()
  store.updateSession('1', { workspace: '/ws', executionMode: 'CLOUD', status: 'ACTIVE' })
  store.setActiveSession('1')

  const quoted: FileRangeQuotePayload[] = []
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(FileViewer, {
        filePath: 'src/a.py',
        provider: {
          readFile: async () => ({ content: 'print("old")\n', total_lines: 1 }),
          listDirectory: async () => ({ entries: [], truncated: false }),
          searchFiles: async () => ({ entries: [], truncated: false }),
        },
      })
    },
  })
  app.config.warnHandler = () => {}
  app.provide('quoteFileRangeToChat', (quote: FileRangeQuotePayload) => { quoted.push(quote) })
  app.use(pinia)
  app.mount(el)
  return {
    store,
    quoted,
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

describe('文件预览去抖期间的引用', () => {
  let mounted: ReturnType<typeof mountViewer> | null = null
  afterEach(() => {
    mounted?.destroy()
    harness.host?.remove()
    harness.host = null
    harness.refreshSelection = null
  })

  it('重载还没开始时，引用不能把新修订号配到仍显示的旧内容上', async () => {
    harness.host = document.createElement('div')
    Object.defineProperty(harness.host, 'clientHeight', { value: 400 })
    document.body.appendChild(harness.host)

    mounted = mountViewer()
    await nextTick()
    harness.refreshSelection?.()

    const button = harness.host.querySelector('.monaco-quote-btn') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    expect(button!.style.display).toBe('block')

    mounted.store.appendFileChange('1', {
      path: 'src/a.py',
      type: 'MODIFIED',
      linesAdded: 1,
      linesDeleted: 0,
    }, '/ws')
    await nextTick()

    expect(mounted.store.fileQuoteRevision('/ws', 'src/a.py')).toBe(1)
    expect(button!.style.display).toBe('block')
    button!.click()

    expect(mounted.quoted).toHaveLength(1)
    expect(mounted.quoted[0].snippet).toBe('print("old")')
    // 屏幕上仍是旧内容。修订号应当还是这一版对应的 0，而不是已经加过的 1。
    expect(mounted.quoted[0].capturedChangeCount).toBe(0)
  })
})
