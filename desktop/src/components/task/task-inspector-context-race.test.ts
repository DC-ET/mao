// Node 环境的 Vue 插件只给 SFC 生成 ssrRender。这里用 compiler-dom 补一份客户端
// render，再用无 DOM 渲染器点按钮、读文本。
// 覆盖：摘要懒加载的迟到响应不得跨会话回填；记忆条数相同的会话切换仍要重拉 snippet；
// 上下文入口从检查器页签改为任务信息区的徽标 + 详情抽屉（抽屉随之懒加载、切会话自动收起）。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { computed, h, nextTick, reactive, ref, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

interface Deferred { promise: Promise<unknown>; resolve: (v: unknown) => void }
function deferred(): Deferred {
  let resolve!: (v: unknown) => void
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}
const summaryDeferreds = new Map<string, Deferred>()
const summaryCallSids: string[] = []
const memoryDeferreds: Deferred[] = []
const memoryCallCount = { value: 0 }

vi.mock('../../api', () => ({
  getSessionCompaction: async (sid: number | string) => {
    summaryCallSids.push(String(sid))
    const d = deferred()
    summaryDeferreds.set(String(sid), d)
    return d.promise
  },
  listMemories: async () => {
    memoryCallCount.value++
    const d = deferred()
    memoryDeferreds.push(d)
    return d.promise
  },
  setSessionMemoryInjectionDisabled: async () => undefined,
}))

vi.mock('../../stores/session', () => {
  const sessions = reactive<Array<Record<string, unknown>>>([])
  return {
    useSessionStore: () => ({
      sessions,
      updateSession: vi.fn((id: string, patch: Record<string, unknown>) => {
        const found = sessions.find(s => String(s.id) === id)
        if (found) Object.assign(found, patch)
      }),
      isSessionCompacting: vi.fn(() => false),
    }),
  }
})

vi.mock('../../composables/useStreamWS', () => ({
  useStreamWS: () => ({ compactNow: vi.fn(async () => true) }),
}))
vi.mock('../../composables/useGitStatus', () => ({
  useGitStatus: () => ({
    loading: ref(false), error: ref(null), status: ref(null), files: ref([]),
    refresh: vi.fn(), refreshRemote: vi.fn(),
  }),
}))
vi.mock('../../composables/useGitRepos', () => ({
  useGitRepos: () => ({
    repos: ref([]), multiRepoMode: ref(false), changedRepos: ref([]), unavailableRepos: ref([]),
    selectedRepoPath: ref(null), selectedRepo: ref(null), loading: ref(false), error: ref(null),
    refresh: vi.fn(), selectRepo: vi.fn(),
  }),
}))
vi.mock('../../composables/useModelContext', () => ({
  useModelContext: () => ({ maxTokens: ref(200000) }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  ElTooltip: defineComponent({ render() { return h('div', this.$slots.default?.() ?? []) } }),
}))

vi.mock('./TodoChecklist.vue', () => ({ default: { render: () => null } }))
vi.mock('./SideTaskList.vue', () => ({ default: { render: () => null } }))
vi.mock('./SubagentList.vue', () => ({ default: { render: () => null } }))
vi.mock('./GitChangeList.vue', () => ({ default: { render: () => null } }))
vi.mock('../file-browser/FileTree.vue', () => ({ default: { render: () => null } }))

import TaskInspector from './TaskInspector.vue'

const descriptor = parse(readFileSync(new URL('./TaskInspector.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'review-inspector' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
// el-drawer 的替身：真实组件会把内容挂到 body 的 teleport 层，这里退化成普通组件，
// 行为对齐「没点开上下文徽标前抽屉内容根本不在 DOM 里」。
// 必须挂在 ClientInspector 自己的 components 上：模板编译产物是 _component_el_drawer，
// 在子组件的渲染作用域里解析，挂 Host 上无效；解析不到组件时 Vue 会退化成原生元素，
// 把抽屉内容直接铺到检查器面板里（v-model 也一起失效）。
const ElDrawerStub = defineComponent({
  name: 'ElDrawerStub',
  props: { modelValue: { type: Boolean, default: false } },
  emits: ['update:modelValue'],
  render() { return this.modelValue ? h('div', this.$slots.default?.() ?? []) : null },
})
const ClientInspector = {
  ...(TaskInspector as object),
  components: { 'el-drawer': ElDrawerStub, ElDrawer: ElDrawerStub },
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; style: { display?: string } }
type StubNode = StubEl | { text: string; parent: StubEl | null }

const handlers = new WeakMap<StubEl, Array<(e?: unknown) => unknown>>()

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {}, style: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: (t: string) => createText(t),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: String(t), parent: el }] },
    insert: (child: StubNode, parent: StubEl, anchor?: StubNode | null) => {
      child.parent = parent
      const idx = anchor ? parent.children.indexOf(anchor) : -1
      if (idx >= 0) parent.children.splice(idx, 0, child)
      else parent.children.push(child)
    },
    remove: (child: StubNode) => {
      const p = child.parent
      if (p) {
        const i = p.children.indexOf(child)
        if (i >= 0) p.children.splice(i, 1)
      }
      child.parent = null
    },
    parentNode: (n: StubNode) => n.parent ?? null,
    nextSibling: (n: StubNode) => {
      const p = n.parent
      if (!p) return null
      return p.children[p.children.indexOf(n) + 1] ?? null
    },
    querySelector: () => null,
    setScopeId: () => {},
    cloneNode: (el: StubEl) => el,
    insertStaticContent: (_content: string, _before: StubNode | null, _parent: StubEl): [StubEl, StubEl] => [
      createElement('static-start'),
      createElement('static-end'),
    ],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
      el.props[key] = next
      if (/^onClick/.test(key) && typeof next === 'function') {
        const arr = handlers.get(el) ?? []
        arr.push(next as (e?: unknown) => unknown)
        handlers.set(el, arr)
      }
    },
  }
}

function subtreeText(el: StubEl): string {
  const acc: string[] = []
  const walk = (n: StubNode) => {
    if ('text' in n) { acc.push(n.text); return }
    for (const c of n.children) walk(c)
  }
  for (const c of el.children) walk(c)
  return acc.join('')
}

function mountInspector(initialMemoryIds: number[]) {
  const sid = ref('11')
  const memoryIds = ref<number[]>(initialMemoryIds)
  const contextWindow = computed(() => ({
    estimated: 100, actual: 50,
    manifest: {
      sections: [{ key: 'messages', label: '会话消息', tokens: 1234, count: 2 }],
      memoryIds: memoryIds.value,
      estimatedWindowTokens: 200000,
    },
  }))
  const Host = defineComponent({
    render: () => h(ClientInspector as never, {
      title: 'T', phase: 'COMPLETED', panelCollapsed: false, fileProvider: null,
      sessionId: sid.value, contextWindow: contextWindow.value,
      executionMode: 'CLOUD', workspace: '/ws', gitProvider: null,
    } as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]

  const findAll = (pred: (el: StubEl) => boolean): StubEl[] => {
    const out: StubEl[] = []
    const walk = (el: StubEl) => {
      if (pred(el)) out.push(el)
      for (const c of el.children) if (!('text' in c)) walk(c)
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    return out
  }
  const clickWhere = (pred: (el: StubEl) => boolean, label: string) => {
    const hit = findAll(el => el.tag === 'button' && pred(el))[0]
    if (!hit) {
      const buttons = findAll(el => el.tag === 'button').map(el => subtreeText(el)).join(' | ')
      throw new Error(`button not found: ${label}; buttons=${buttons || '(none)'}`)
    }
    const arr = handlers.get(hit)
    if (!arr || !arr.length) throw new Error(`no click handler on: ${label}`)
    return arr[arr.length - 1]!()
  }
  return {
    sid, memoryIds,
    clickContextBadge: () => clickWhere(el => subtreeText(el).includes('上下文'), 'context badge'),
    clickSummaryToggle: () => clickWhere(el => String(el.props.class ?? '') === 'ctx-summary-toggle', 'summary toggle'),
    pageText: () => subtreeText(root),
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

// 两个 describe 共用同一套 mock 记帐，重置放在文件级 beforeEach，避免用例间串数
beforeEach(() => {
  summaryCallSids.length = 0
  summaryDeferreds.clear()
  memoryDeferreds.length = 0
  memoryCallCount.value = 0
})

describe('TaskInspector 上下文详情抽屉：会话切换清理/竞态（round3 复现）', () => {
  it('BUG-A：切会话后旧摘要迟到响应必须被丢弃，新会话重新加载且不得显示旧会话摘要', async () => {
    const m = mountInspector([])
    m.clickContextBadge()
    await flush()

    m.clickSummaryToggle()
    await flush()
    expect(summaryCallSids).toEqual(['11'])

    m.sid.value = '22'
    await flush()

    summaryDeferreds.get('11')!.resolve({
      summaryText: 'SUMMARY-OF-SESSION-11', compactCount: 3, compactModel: 'm', updatedAt: 'x',
    })
    await flush()

    // 抽屉在切会话时已自动收起，需重新点开徽标才会为新会话再读一次摘要
    m.clickContextBadge()
    await flush()
    m.clickSummaryToggle()
    await flush()

    expect({
      requests: [...summaryCallSids],
      showsOldSummary: m.pageText().includes('SUMMARY-OF-SESSION-11'),
    }).toEqual({
      requests: ['11', '22'],
      showsOldSummary: false,
    })
  })

  it('BUG-B：新旧会话记忆条数相同时，切会话应重新拉取 snippet，chip 不停留在「记忆 #id」', async () => {
    const m = mountInspector([1, 2])
    m.clickContextBadge()
    await flush()
    expect(memoryCallCount.value).toBe(1)
    memoryDeferreds[0]!.resolve({ records: [{ id: 1, content: '记忆一' }, { id: 2, content: '记忆二' }] })
    await flush()
    expect(m.pageText()).toContain('记忆一')

    m.memoryIds.value = [3, 4]
    m.sid.value = '22'
    await flush()

    // 抽屉已随切会话收起，重新点开才会去拉新会话的 snippet
    m.clickContextBadge()
    await flush()

    expect(memoryCallCount.value, `条数相同也必须重拉 snippet；当前回退文案=${m.pageText().includes('记忆 #3')}`).toBe(2)
  })
})

describe('TaskInspector 上下文入口：徽标开抽屉，无顶层页签（0.0.244）', () => {
  it('未点击时不拉取 snippet，也不渲染抽屉内容；点击后才懒加载', async () => {
    const m = mountInspector([1, 2])
    await flush()
    expect(memoryCallCount.value).toBe(0)
    expect(m.pageText()).not.toContain('上下文容量')

    m.clickContextBadge()
    await flush()
    expect(memoryCallCount.value).toBe(1)
    expect(m.pageText()).toContain('上下文容量')
    expect(m.pageText()).toContain('手动整理上下文')
    // 容量保持模型水位 max(estimated=100, actual=50)，不改成构成原始估算 1234。
    expect(m.pageText()).toContain('100/200k（0%）')
    expect(m.pageText()).not.toContain('1.2k')
  })

  it('切换会话后抽屉自动关闭，必须重新点击徽标才会再展示', async () => {
    const m = mountInspector([])
    m.clickContextBadge()
    await flush()
    expect(m.pageText()).toContain('上下文容量')

    m.sid.value = '22'
    await flush()

    expect(m.pageText()).not.toContain('上下文容量')
    m.clickContextBadge()
    await flush()
    expect(m.pageText()).toContain('上下文容量')
  })
})
