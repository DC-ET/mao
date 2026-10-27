/**
 * @vitest-environment jsdom
 */
import { nextTick, ref, h } from 'vue'
import { createApp } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it } from 'vitest'
import ChatInput from './ChatInput.vue'
import { useSessionStore } from '../../stores/session'
import { useDraftStore } from '../../stores/draft'
import { resolveFileRefPaths } from '../../composables/useChat'
import { splitUserMessageForDisplay } from '../../utils/selection-quote'
import type { FileRangeQuotePayload } from '../../utils/selection-quote'

interface ChatHandle {
  addReplyQuote: (text: string) => void
  insertFileRangeQuote: (quote: FileRangeQuotePayload) => void
}

function installDomShims() {
  if (!window.matchMedia) {
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
  const elementFromPoint = () => null
  document.elementFromPoint = elementFromPoint
  if (!Document.prototype.elementFromPoint) {
    Document.prototype.elementFromPoint = elementFromPoint
  }
}

function mountChatInput(props: Record<string, unknown> = {}) {
  installDomShims()
  const pinia = createPinia()
  setActivePinia(pinia)
  const sent: string[] = []
  const inputRef = ref<{
    getPlainText: () => string
    clearInput: () => void
    restoreContent: (
      text: string,
      files: File[],
      quotes?: Array<{ id: string; text: string; truncated: boolean }>,
    ) => void
    insertText: (text: string) => void
  } | null>(null)
  let handle: ChatHandle | null = null
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp({
    setup() {
      return () => h(ChatInput, {
        ref: inputRef,
        workspace: '/ws',
        draftKey: 's:1',
        registerKey: 'chat',
        ...props,
        onSend: (text: string) => { sent.push(text) },
      })
    },
  })
  app.config.warnHandler = () => {}
  app.provide('registerChatInput', (_key: string, next: ChatHandle) => { handle = next })
  app.provide('unregisterChatInput', () => {})
  app.use(pinia)
  app.mount(el)
  return {
    pinia,
    sent,
    get input() { return inputRef.value },
    get handle() { return handle },
    destroy() {
      app.unmount()
      el.remove()
    },
  }
}

function change(path: string) {
  return { path, type: 'MODIFIED' as const, linesAdded: 1, linesDeleted: 0 }
}

describe('回复引用发送后的清空判定', () => {
  let mounted: ReturnType<typeof mountChatInput> | null = null
  afterEach(() => { mounted?.destroy() })

  it('只带回复引用发出后，父组件按原文比对应清空输入', async () => {
    mounted = mountChatInput()
    await nextTick()
    mounted.input!.insertText('请解释')
    mounted.handle!.addReplyQuote('引用的回复')
    await nextTick()

    const button = document.querySelector('button[title="发送 (Enter)"]') as HTMLButtonElement | null
    expect(button).toBeTruthy()
    expect(button!.disabled).toBe(false)
    button!.click()

    expect(mounted.sent).toHaveLength(1)
    const sentText = mounted.sent[0]
    expect(sentText).toContain('引用的回复')
    expect(sentText).toContain('请解释')
    // ChatPanel.clearInputIfUnedited：只有 getPlainText() === 已发送文本 才清空。
    const plain = mounted.input!.getPlainText()
    if (plain === sentText.trim()) mounted.input!.clearInput()
    await nextTick()

    expect(plain).toBe(sentText.trim())
    expect(document.querySelector('.reply-quote-item')).toBeNull()
    expect(mounted.input!.getPlainText()).toBe('')
  })
})

describe('行区间引用的过期标记', () => {
  let mounted: ReturnType<typeof mountChatInput> | null = null
  afterEach(() => { mounted?.destroy() })

  it('打开 Diff 之后文件又改过，插入时就要标内容可能已变化', async () => {
    mounted = mountChatInput()
    await nextTick()
    const store = useSessionStore()
    store.appendFileChange('1', change('src/a.py'), '/ws')
    store.appendFileChange('1', change('src/a.py'), '/ws')
    await nextTick()

    mounted.handle!.insertFileRangeQuote({
      filePath: 'src/a.py',
      lineStart: 3,
      lineEnd: 4,
      snippet: 'print(1)',
      languageId: 'python',
      capturedChangeCount: 1,
    })
    await nextTick()

    const tag = document.querySelector('.editor-tag-file')
    expect(tag?.textContent).toContain('内容可能已变化')
  })
})

describe('行区间片段里的文件标记', () => {
  // 方案已接受：片段里的 @{ }@ / #{ }# / ${ }$ 仍走现有解析，不改正则、不插零宽字符。
  it('片段中的 @{path}@ 会和标记本身一起被改写', () => {
    const workspace = '/Users/me/project'
    const raw = '@{src/a.py}@ 第 3 行：\n```python\nprint("@{util.py}@")\n```\n请解释'
    expect(resolveFileRefPaths(raw, workspace)).toBe(
      '@{/Users/me/project/src/a.py}@ 第 3 行：\n```python\nprint("@{/Users/me/project/util.py}@")\n```\n请解释',
    )
  })

  it('气泡折叠时片段里的 @{path}@ 会被当成文件引用', () => {
    const raw = '@{src/a.py}@ 第 3 行：\n```python\nprint("@{util.py}@")\n```\n请解释'
    const view = splitUserMessageForDisplay(raw)
    expect(view.segments.some(seg => seg.type === 'file' && seg.filePath === 'util.py')).toBe(true)
    const visible = view.segments.map(seg => seg.type === 'text' ? seg.content : '').join('')
    expect(visible).toContain('请解释')
  })
})

describe('新建任务失败回填', () => {
  let mounted: ReturnType<typeof mountChatInput> | null = null
  afterEach(() => { mounted?.destroy() })

  it('回填草稿文本后回复引用还在', async () => {
    mounted = mountChatInput({ draftKey: 'new', isNewTask: true, selectedAgentId: 'agent-1' })
    await nextTick()
    mounted.input!.insertText('请解释')
    mounted.handle!.addReplyQuote('引用的回复')
    await nextTick()
    const draft = useDraftStore().getDraft('new')
    expect(draft?.quotes?.[0]?.text).toBe('引用的回复')
    // ChatPanel 首发失败回填：restoreContent(entry.text, files)
    mounted.input!.restoreContent(draft!.text, [])
    await nextTick()
    const button = document.querySelector('button[title="发送 (Enter)"]') as HTMLButtonElement
    button.click()
    expect(mounted.sent[0] ?? '').toContain('引用的回复')
  })

  it('输入框已经被清掉之后，按草稿里的引用回填', async () => {
    mounted = mountChatInput({ draftKey: 'new', isNewTask: true, selectedAgentId: 'agent-1' })
    await nextTick()
    mounted.input!.insertText('请解释')
    mounted.handle!.addReplyQuote('引用的回复')
    await nextTick()
    const draft = useDraftStore().getDraft('new')
    expect(draft?.quotes?.[0]?.text).toBe('引用的回复')
    mounted.input!.clearInput()
    mounted.input!.restoreContent(draft!.text, [], draft!.quotes ?? [])
    await nextTick()
    const button = document.querySelector('button[title="发送 (Enter)"]') as HTMLButtonElement
    button.click()
    expect(mounted.sent[0] ?? '').toContain('引用的回复')
  })
})
