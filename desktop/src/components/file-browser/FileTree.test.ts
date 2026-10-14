// 文件树「重试」按钮与错误行点击回归用例（2026-10-13 round3 BUG-4）。
//
// 原缺陷一：loadChildren 失败时造出的占位错误节点是 { isDirectory: false, path: <失败目录> }，
// FileTree.handleRetry 直接对它 expandDir，被 useFileBrowser.expandDir 首行的
// `!node.isDirectory` 守卫挡掉——点「重试」只抹掉错误文案、留一行空白节点，不发任何新请求。
// 原缺陷二（次生）：点错误行本身会走 open-file，把失败目录当文件打开成页签。
//
// 这里挂载真实 FileTree.vue 与真实 FileTreeNode.vue（handleRetry / expandDir / handleClick
// 全是生产代码），只把图标与两个弹窗子组件换成空替身；渲染走无 DOM 的自定义 renderer。
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }) }
})

import FileTree from './FileTree.vue'
import FileTreeNode from './FileTreeNode.vue'
import { parse, compileScript, type BindingMetadata } from '@vue/compiler-sfc'
import { BindingTypes } from '@vue/compiler-core'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

/** 编译一个 SFC 的模板为 client render（node 环境下 vitest 只给 SSR 形态，没有 render）。 */
function compileSfcTemplate(relativePath: string, id: string, extraBindings: Record<string, BindingTypes> = {}) {
  const descriptor = parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8')).descriptor
  const compiledScript = compileScript(descriptor, { id })
  // compiler-dom 不剥离模板内联表达式里的 TS 断言，生成的 render 不是合法 JS；只去掉纯类型断言。
  const templateSource = descriptor.template!.content.replace(/ as HTMLInputElement/g, '')
  const compiledTemplate = compile(templateSource, {
    mode: 'function',
    prefixIdentifiers: true,
    // compiledScript.bindings 还带 __isScriptSetup / __propsAliases 等非 BindingTypes 字段，过不了类型
    bindingMetadata: { ...compiledScript.bindings, ...extraBindings } as unknown as BindingMetadata,
  })
  return new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
}

/** 把 vitest 编译出的 SSR setup 包一层：跑真实 setup，再把替身组件并回 setupState。 */
function wrap(component: unknown, render: (ctx: unknown, cache: unknown) => unknown, inject: Record<string, unknown>) {
  const originalSetup = (component as { setup: (p: unknown, c: unknown) => Record<string, unknown> }).setup
  return {
    ...(component as object),
    setup(props: unknown, ctx: unknown) {
      const context = ctx as { expose?: () => void }
      const bindings = originalSetup(props, { ...context, expose: context.expose ?? (() => {}) }) ?? {}
      return { ...bindings, ...inject }
    },
    render,
  }
}

const NullStub = defineComponent({ name: 'NullStub', render: () => null })
const iconStubs = {
  Folder: NullStub,
  FolderOpened: NullStub,
  Document: NullStub,
  Picture: NullStub,
  ArrowRight: NullStub,
  ArrowDown: NullStub,
  Link: NullStub,
}
// SFC 不会 import 自身，compileScript 的 bindings 里没有 FileTreeNode；真实的 compileTemplate
// 会补上自引用，这里手工补，否则递归子节点会退化成原生 <FileTreeNode> 元素。
const nodeRender = compileSfcTemplate('./FileTreeNode.vue', 'file-tree-node', { FileTreeNode: BindingTypes.SETUP_CONST })

// 模板里递归引用自身，setupState 里的这一项必须指向包好的组件
const NodeComponent: Record<string, unknown> = wrap(FileTreeNode, nodeRender, {
  ...iconStubs,
  FileTreeNode: null as unknown,
})
;(NodeComponent as { setup: unknown }).setup = wrap(FileTreeNode, nodeRender, {
  ...iconStubs,
  FileTreeNode: NodeComponent,
}).setup

const TreeComponent = wrap(FileTree, compileSfcTemplate('./FileTree.vue', 'file-tree'), {
  Search: NullStub,
  Refresh: NullStub,
  Files: NullStub,
  FileTreeNode: NodeComponent,
  FileTreeContextMenu: NullStub,
  DownloadLinkDialog: NullStub,
})

/* ---------- 无 DOM 渲染器（同 UsageDetailTab.test.ts 套路） ---------- */

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown>; focus: () => void }
type StubNode = StubEl | { text: string; parent: StubEl | null }
interface HandlerEntry { key: string; fn: (e?: unknown) => unknown }

function nodeOps() {
  const handlers = new Map<StubEl, HandlerEntry[]>()
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {}, focus: () => {} })
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
      insertStaticContent: () => [createElement('static-start'), createElement('static-end')] as [StubEl, StubEl],
      patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => {
        el.props[key] = next
        if (/^on[A-Z]/.test(key)) {
          const fns = Array.isArray(next) ? next : [next]
          for (const fn of fns) {
            if (typeof fn === 'function') {
              const arr = handlers.get(el) ?? []
              arr.push({ key, fn: fn as (e?: unknown) => unknown })
              handlers.set(el, arr)
            }
          }
        }
      },
    },
  }
}

async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

/** 占位事件对象：@click.stop / .prevent 的守卫会读它，不能传 undefined。 */
function fakeEvent() {
  return {
    clientX: 0,
    clientY: 0,
    target: {},
    preventDefault() {},
    stopPropagation() {},
  }
}

function mountTree(provider: unknown) {
  const opened: Array<{ path: string; title: string }> = []
  const Host = defineComponent({
    render: () => h(TreeComponent as never, {
      workspace: '/tmp/ws',
      executionMode: 'CLOUD',
      provider,
      sessionId: '1',
      onOpenFile: (p: { path: string; title: string }) => opened.push(p),
    } as never),
  })
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const errors: unknown[] = []
  const app = createApp(Host)
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]

  /** 按 class 找可点元素；index 默认取最后一个（后渲染的节点在文档流后面）。 */
  const click = (selector: string, index = -1, key = 'onClick') => {
    const hit: StubEl[] = []
    const walk = (el: StubEl) => {
      const entries = handlers.get(el) ?? []
      if (String(el.props.class ?? '').split(' ').includes(selector) && entries.length > 0) hit.push(el)
      for (const c of el.children) if (!('text' in c)) walk(c)
    }
    for (const c of root.children) if (!('text' in c)) walk(c)
    if (hit.length === 0) throw new Error(`element not found: ${selector}`)
    const el = hit.at(index)
    if (el == null) throw new Error(`element index out of range: ${selector}[${index}] of ${hit.length}`)
    // 同一元素上会累积多个 on*（重渲染反复 patchProp 不清理），必须按 key 取，否则会点到别的监听
    const entries = (handlers.get(el) ?? []).filter((e) => e.key === key)
    if (entries.length === 0) throw new Error(`no handler ${key} on ${selector}[${index}]`)
    entries[entries.length - 1]!.fn(fakeEvent())
  }
  return { click, opened }
}

function callsFor(listDirectory: ReturnType<typeof vi.fn>, path: string): number {
  return listDirectory.mock.calls.filter((c) => c[0] === path).length
}

const srcEntry = { name: 'src', path: 'src', isDirectory: true, size: 0, isSymlink: false }
const aEntry = { name: 'a.ts', path: 'src/a.ts', isDirectory: false, size: 1, isSymlink: false }

describe('文件树「重试」按钮', () => {
  let listDirectory: ReturnType<typeof vi.fn>

  beforeEach(() => {
    listDirectory = vi.fn()
  })

  it('子目录列举失败后点「重试」会重新拉取该目录', async () => {
    listDirectory.mockImplementation(async (path: string) => {
      if (path === '') return { entries: [srcEntry], truncated: false }
      return { error: '权限不足', entries: [] }
    })
    const tree = mountTree({ listDirectory } as never)
    await flush()

    // 展开 src：其列举失败 → 出现错误行与重试按钮
    tree.click('node-row', 0)
    await flush()
    expect(callsFor(listDirectory, 'src')).toBe(1)

    tree.click('retry-btn')
    await flush()

    expect(callsFor(listDirectory, 'src')).toBe(2)
    expect(tree.opened).toEqual([])
  })

  it('根目录列举失败后点「重试」会重新拉取根', async () => {
    let calls = 0
    listDirectory.mockImplementation(async (path: string) => {
      calls += 1
      // 根失败一次后恢复；其余路径必须返回别的内容，否则 src 的子节点还是 src，
      // compactSingleChildDirs 会无限自我折叠
      if (path !== '') return { entries: [], truncated: false }
      return calls === 1 ? { error: '读取工作区失败', entries: [] } : { entries: [srcEntry], truncated: false }
    })
    const tree = mountTree({ listDirectory } as never)
    await flush()
    expect(calls).toBe(1)

    tree.click('retry-btn')
    await flush()

    expect(calls).toBe(2)
    // 重试成功后根下出现 src 行，点它应正常展开
    tree.click('node-row', 0)
    await flush()
    expect(callsFor(listDirectory, 'src')).toBe(1)
  })

  it('点列举失败的错误行不会把目录当文件打开', async () => {
    listDirectory.mockImplementation(async (path: string) => {
      if (path === '') return { entries: [srcEntry], truncated: false }
      return { error: '权限不足', entries: [] }
    })
    const tree = mountTree({ listDirectory } as never)
    await flush()

    tree.click('node-row', 0)
    await flush()
    // 错误行的 path 其实是目录（'src'），点它不应触发 open-file
    tree.click('node-row', -1)
    await flush()

    expect(tree.opened).toEqual([])
  })

  it('重试成功后错误行消失、目录内容可展开', async () => {
    let srcCalls = 0
    listDirectory.mockImplementation(async (path: string) => {
      if (path === '') return { entries: [srcEntry], truncated: false }
      srcCalls += 1
      if (srcCalls === 1) return { error: '权限不足', entries: [] }
      return { entries: [aEntry], truncated: false }
    })
    const tree = mountTree({ listDirectory } as never)
    await flush()

    tree.click('node-row', 0)
    await flush()
    expect(callsFor(listDirectory, 'src')).toBe(1)

    tree.click('retry-btn')
    await flush()

    expect(callsFor(listDirectory, 'src')).toBe(2)
    // src 已展开：再点一次是收起，不应再发列举请求
    tree.click('node-row', 0)
    await flush()
    expect(callsFor(listDirectory, 'src')).toBe(2)
  })
})
