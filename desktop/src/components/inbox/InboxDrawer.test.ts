// Node 环境无 DOM：.vue 在 vitest 下只编译出 ssrRender，手动编译模板补客户端 render，
// 再用无 DOM 渲染器点列表项（同 UsageDetailTab.test.ts 套路）。
// 覆盖 BUDGET_WARN 分支（决策 10）：点击派发 open_usage_drawer { tab: 'budget' } 且关抽屉，
// 取代原来落到「该通知没有关联会话」的死端；其余 kind 路径逐字节不变（C9 回归）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, ref, defineComponent, createRenderer } from 'vue'

const captured = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  fetchSession: vi.fn(async (id: string) => ({ id: Number(id), title: '会话' })),
  pushed: [] as string[],
  warnings: [] as string[],
  openUsageEvents: [] as Array<{ tab?: string } | undefined>,
  closed: 0,
}))

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

// window 在 node 环境不存在：用 EventTarget 顶替，组件里的 add/remove/dispatch 全部走它
const windowTarget = new EventTarget()
vi.stubGlobal('window', windowTarget)

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: (p: string) => captured.pushed.push(p) }),
}))

vi.mock('element-plus', () => ({
  ElMessage: { warning: (m: string) => captured.warnings.push(m) },
}))

vi.mock('../../stores/inbox', () => ({
  useInboxStore: () => ({
    items: [],
    unreadOnly: false,
    unreadCount: 0,
    loadingList: false,
    loadingMore: false,
    hasMore: false,
    get visibleItems() { return captured.items },
    fetchList: vi.fn(async () => undefined),
    fetchInboxPreference: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    markAllRead: vi.fn(async () => undefined),
    setUnreadOnly: vi.fn(),
    loadMore: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: () => ({
    fetchSession: captured.fetchSession,
    setActiveSession: vi.fn(),
  }),
}))

vi.mock('../../composables/useRelativeTime', () => ({
  useRelativeTime: () => ({}),
  formatRelativeTime: () => '3 分钟前',
}))

vi.mock('../../composables/useInboxSystemNotify', () => ({
  primeInboxSystemNotify: vi.fn(),
}))

vi.mock('./DigestDetailDialog.vue', () => ({
  default: { name: 'DigestDetailDialogStub', render() { return h('div', { class: 'digest-stub' }) } },
}))

import InboxDrawer from './InboxDrawer.vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

const descriptor = parse(readFileSync(new URL('./InboxDrawer.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'inbox-drawer' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const DrawerComponent = {
  ...(InboxDrawer as object),
  render: clientRender,
}

/** el-drawer 替身：渲染默认插槽（v-model 经 modelValue/onUpdate:modelValue 贯通）。 */
const DrawerStub = defineComponent({
  name: 'DrawerStub',
  props: { modelValue: Boolean },
  emits: ['update:modelValue'],
  render() {
    return h('div', { class: 'drawer-stub' }, this.$slots.default?.())
  },
})

const CheckboxStub = defineComponent({
  name: 'CheckboxStub',
  render() { return h('input', { type: 'checkbox' }) },
})

const ButtonStub = defineComponent({
  name: 'ButtonStub',
  render() { return h('button', {}, this.$slots.default?.()) },
})

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  // 按 key 存处理器（li 上 @click 与 @keydown.enter 并存，取最后一个数组元素会取到 keydown 的）
  const handlers = new Map<StubEl, Map<string, Array<(e?: unknown) => unknown>>>()
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    handlers,
    ops: {
      createElement,
      createText,
      createComment: (t: string) => createText(t),
      setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
      setElementText: (el: StubEl, t: string) => { el.children = [{ text: String(t), parent: el }] },
      insert: (child: StubNode, parent: StubEl) => { child.parent = parent; parent.children.push(child) },
      remove: (child: StubNode) => {
        const p = child.parent
        if (p && !('text' in p)) {
          const i = p.children.indexOf(child)
          if (i >= 0) p.children.splice(i, 1)
          child.parent = null
        }
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
      insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
      patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
        el.props[key] = next
        if (/^on[A-Z]/.test(key)) {
          const fns = Array.isArray(next) ? next : [next]
          for (const fn of fns) {
            if (typeof fn === 'function') {
              const byKey = handlers.get(el) ?? new Map<string, Array<(e?: unknown) => unknown>>()
              const arr = byKey.get(key) ?? []
              arr.push(fn as (e?: unknown) => unknown)
              byKey.set(key, arr)
              handlers.set(el, byKey)
            }
          }
        }
      },
    },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
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

function mount() {
  const open = ref(true)
  const Host = defineComponent({
    render: () => h(DrawerComponent as never, {
      modelValue: open.value,
      'onUpdate:modelValue': (v: boolean) => { open.value = v; captured.closed = v ? 0 : 1 },
    } as never),
  })
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(Host)
  app.component('el-drawer', DrawerStub)
  app.component('el-checkbox', CheckboxStub)
  app.component('el-button', ButtonStub)
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]

  const clickItem = (title: string) => {
    const hit: StubEl[] = []
    const walk = (el: StubEl) => {
      if (el.tag === 'li' && subtreeText(el).includes(title)) hit.push(el)
      for (const c of el.children) if (!('text' in c)) walk(c)
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    const el = hit[0]
    if (!el) throw new Error(`item not found: ${title}`)
    const arr = handlers.get(el)?.get('onClick')
    if (!arr || !arr.length) throw new Error(`no click handler on: ${title}`)
    return arr[arr.length - 1]!()
  }
  return { clickItem }
}

function item(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 1, kind: 'TASK_COMPLETED', title: '任务完成', content: '内容', isRead: true, sessionId: 42, payload: {}, createdAt: '2026-10-26 10:00:00', ...overrides }
}

// window 是整文件共用的 EventTarget：监听器提为模块级引用，beforeEach 注册、afterEach 注销，
// 否则跨用例累积——后派发的用例会被前面每个用例的监听器各推一次，断言条数悄悄翻倍。
const openUsageListener = ((e: CustomEvent<{ tab?: string }>) => {
  captured.openUsageEvents.push(e.detail)
}) as EventListener

beforeEach(() => {
  captured.items.length = 0
  captured.pushed.length = 0
  captured.warnings.length = 0
  captured.openUsageEvents.length = 0
  captured.closed = 0
  captured.fetchSession.mockClear()
  windowTarget.addEventListener('open_usage_drawer', openUsageListener)
})

afterEach(() => {
  windowTarget.removeEventListener('open_usage_drawer', openUsageListener)
})

describe('InboxDrawer BUDGET_WARN 分支', () => {
  it('BUDGET_WARN 点击 → 派发 open_usage_drawer { tab: budget } 并关抽屉（原死端消除）', async () => {
    captured.items = [item({ kind: 'BUDGET_WARN', title: '预算提醒', sessionId: null })]
    const m = mount()
    await flush()
    m.clickItem('预算提醒')
    await flush()
    expect(captured.openUsageEvents).toEqual([{ tab: 'budget' }])
    expect(captured.closed).toBe(1)
    // 不再走「该通知没有关联会话」警告
    expect(captured.warnings).toEqual([])
    expect(captured.pushed).toEqual([])
  })

  it('回归：TASK_COMPLETED 仍跳关联会话，不派发用量事件', async () => {
    captured.items = [item({ kind: 'TASK_COMPLETED', title: '任务完成' })]
    const m = mount()
    await flush()
    m.clickItem('任务完成')
    await flush()
    expect(captured.fetchSession).toHaveBeenCalledWith('42')
    expect(captured.pushed).toEqual(['/tasks/42'])
    expect(captured.openUsageEvents).toEqual([])
    expect(captured.closed).toBe(1)
  })

  it('回归：无关联会话的其他 kind 仍警告「该通知没有关联会话」', async () => {
    captured.items = [item({ kind: 'TASK_FAILED', title: '任务失败', sessionId: null })]
    const m = mount()
    await flush()
    m.clickItem('任务失败')
    await flush()
    expect(captured.warnings).toEqual(['该通知没有关联会话'])
    expect(captured.openUsageEvents).toEqual([])
    expect(captured.pushed).toEqual([])
  })

  it('回归：DAILY_DIGEST 仍走详情对话框，不派发用量事件', async () => {
    captured.items = [item({ kind: 'DAILY_DIGEST', title: '每日摘要', sessionId: null })]
    const m = mount()
    await flush()
    m.clickItem('每日摘要')
    await flush()
    expect(captured.openUsageEvents).toEqual([])
    expect(captured.warnings).toEqual([])
  })
})
