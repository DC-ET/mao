// 「请求构成」tab 的组件行为回归：工具清单 chips。
// 桌面 vitest 是 node 环境、无 DOM：挂载 SFC 走「vi.mock('vue' useSSRContext) +
// compileScript / compile + new Function('Vue', compiled.code) + 自绘 nodeOps」三件套
// （与 run-trace-record-drawer.test.ts 同一套手法）。
//
// 覆盖：toolsJson 保序不去重（后端 captureToolNames 契约）——同一轮内多次调用同一
// 工具会产生同名 chip，v-for key 必须带 index，否则 Vue 重复 key 告警且更新时可能错位。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { defineComponent, h, nextTick, createRenderer, ref } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import type { TraceCallMeta } from '../../types/trace'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

function makeCall(toolsJson: string | null, systemPrompt: string | null = '你是运维助手'): TraceCallMeta {
  return {
    llmCallId: 101, provider: 'anthropic', protocol: 'openai', stream: true, effort: 'medium',
    scene: 'agent', modelName: 'step-5', retryCount: 0, firstTokenMs: 800, durationMs: 4200,
    errorMessage: null, promptTokens: 1000, completionTokens: 200, cachedTokens: 300,
    cacheCreationTokens: 40, costMicros: 2_500_000, createdAt: '2026-10-10 09:03:00',
    systemPrompt, toolsJson,
  }
}

import RunTraceCallPrompt from './RunTraceCallPrompt.vue'

const descriptor = parse(readFileSync(new URL('./RunTraceCallPrompt.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'call-prompt' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ClientPrompt = {
  ...(RunTraceCallPrompt as object),
  components: {},
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    createElement,
    createText,
    createComment: () => createText(''),
    setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
    setElementText: (el: StubEl, t: string) => { el.children = [{ text: t, parent: el }] },
    insert: (child: StubNode, parent: StubEl) => { child.parent = parent; parent.children.push(child) },
    remove: (child: StubNode) => {
      const p = child.parent
      if (p && !('text' in child)) {
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
    insertStaticContent: () => [createElement('s1'), createElement('s2')] as [StubEl, StubEl],
    patchProp: (el: StubEl, key: string, _prev: unknown, next: unknown) => { el.props[key] = next },
  }
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function collectText(node: StubNode | null): string {
  if (node == null) return ''
  if ('text' in node) return node.text
  return node.children.map((child) => collectText(child)).join('')
}

function findAllByClass(node: StubNode | null, cls: string): StubEl[] {
  if (node == null || 'text' in node) return []
  const self = typeof node.props.class === 'string' && node.props.class.split(' ').includes(cls) ? [node] : []
  return [...self, ...node.children.flatMap((child) => findAllByClass(child, cls))]
}

const warnings: string[] = []

async function mountPrompt(initial: TraceCallMeta) {
  const call = ref(initial)
  const Host = defineComponent({
    render: () => h(ClientPrompt as never, { call: call.value } as never),
  })
  const ops = nodeOps()
  const { createApp } = createRenderer(ops)
  const root = ops.createElement('root')
  const app = createApp(Host)
  app.config.warnHandler = (msg) => { warnings.push(String(msg)) }
  app.mount(root as never)
  await flush()
  return { root, call }
}

describe('RunTraceCallPrompt 工具清单', () => {
  beforeEach(() => {
    warnings.length = 0
  })

  it('同名工具多次调用渲染多个 chip，内容与顺序保真', async () => {
    const { root } = await mountPrompt(makeCall('["read_file","read_file","shell"]'))
    const chips = findAllByClass(root, 'prompt-tool-chip')
    expect(chips.map(collectText)).toEqual(['read_file', 'read_file', 'shell'])
  })

  it('工具清单更新为另一组同名清单：无重复 key 告警（回归：key 仅用 name 会被 Vue 告警）', async () => {
    const { root, call } = await mountPrompt(makeCall('["read_file","read_file","shell"]'))
    call.value = makeCall('["shell","shell","read_file"]')
    await flush()
    const chips = findAllByClass(root, 'prompt-tool-chip')
    // stub 渲染器的 insert 忽略 anchor，更新后顺序不可断言；按多重集合校验内容不丢不重
    expect(chips.map(collectText).sort()).toEqual(['read_file', 'shell', 'shell'])
    // 同名 chip 的 key 必须带 index：仅用 name 时 Vue 对重复 key 发告警（实测旧 key 命中）
    expect(warnings.filter((w) => /duplicate key/i.test(w))).toEqual([])
  })

  it('toolsJson 为 null（历史行）时不渲染 chip，给说明文案', async () => {
    const { root } = await mountPrompt(makeCall(null))
    expect(findAllByClass(root, 'prompt-tool-chip')).toHaveLength(0)
    const flat = collectText(root)
    expect(flat).toContain('未记录')
  })

  it('toolsJson 解析失败（非数组/坏 JSON）不渲染 chip 也不抛', async () => {
    const { root } = await mountPrompt(makeCall('{"a":1}'))
    expect(findAllByClass(root, 'prompt-tool-chip')).toHaveLength(0)
    const broken = await mountPrompt(makeCall('not-json'))
    expect(findAllByClass(broken.root, 'prompt-tool-chip')).toHaveLength(0)
  })
})
