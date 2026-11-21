// Node 环境无 DOM：.vue 在 vitest 下只编译出 ssrRender，手动编译模板补客户端 render，
// 再用无 DOM 渲染器挂载（同 InboxDrawer.test.ts 套路）。
// 覆盖内置技能标签（技术方案 2026-11-20 §6）：系统技能卡片对 builtin=true 渲染「内置」、
// 上传的系统技能渲染「系统」，提示文案说明两类技能的来源。
import { describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'

// compileScript 产出的 setup 会调 useSSRContext().modules.add（SSR 样式收集），node 环境没有 SSR 上下文
vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const captured = vi.hoisted(() => ({
  gets: [] as string[],
}))

vi.mock('element-plus', () => ({
  ElMessage: { warning: () => undefined, success: () => undefined, error: () => undefined },
}))

vi.mock('@element-plus/icons-vue', () => ({
  Check: { name: 'CheckStub', render: () => null },
  Close: { name: 'CloseStub', render: () => null },
}))

vi.mock('../../api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      captured.gets.push(url)
      if (url === '/skill-docs') {
        return {
          data: [
            { name: 'mao-cli', description: '内置技能', folderPath: '/opt/mao/skills/mao-cli', builtin: true },
            { name: 'team-skill', description: '上传的系统技能', folderPath: '/opt/mao-data/skills/team-skill', builtin: false },
          ],
        }
      }
      if (url === '/user-skills') return { data: [] }
      return { data: [] }
    }),
  },
}))

vi.mock('../common/MarkdownContent.vue', () => ({
  default: { name: 'MarkdownContentStub', render: () => null },
}))

// window 在 node 环境不存在：用 EventTarget 顶替；不挂 electronAPI → isElectron=false，本地技能分支不激活
vi.stubGlobal('window', new EventTarget())

import SkillManager from './SkillManager.vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'
import { readFileSync } from 'node:fs'

const descriptor = parse(readFileSync(new URL('./SkillManager.vue', import.meta.url), 'utf8')).descriptor
const compiledScript = compileScript(descriptor, { id: 'skill-manager' })
const compiledTemplate = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: compiledScript.bindings,
})
const clientRender = new Function('Vue', compiledTemplate.code)(Vue) as (ctx: unknown, cache: unknown) => unknown
const SkillManagerComponent = {
  ...(SkillManager as object),
  render: clientRender,
}

/** 透传默认插槽的通用替身；dialog/badge/divider 不渲染内容。 */
const passthrough = (name: string) => defineComponent({
  name,
  inheritAttrs: false,
  setup(_, { slots }) { return () => slots.default?.() },
})
const empty = (name: string) => defineComponent({ name, inheritAttrs: false, render: () => null })

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  const createElement = (tag: string): StubEl => ({ tag, children: [], parent: null, props: {} })
  const createText = (text: string): StubNode => ({ text, parent: null })
  return {
    ops: {
      createElement,
      createText,
      createComment: (t: string) => createText(t),
      setText: (n: StubNode, t: string) => { if ('text' in n) n.text = String(t) },
      setElementText: (el: StubEl, t: string) => { el.children = [createText(t)] },
      insert: (child: StubNode, parent: StubEl) => { child.parent = parent; parent.children.push(child) },
      remove: (child: StubNode) => {
        const p = child.parent
        if (p && !('text' in child)) {
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
      patchProp: (el: StubEl, key: string) => { el.props[key] = key },
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
  const { ops } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(defineComponent({ render: () => h(SkillManagerComponent as never) }))
  app.component('el-tabs', passthrough('TabsStub'))
  app.component('el-tab-pane', passthrough('TabPaneStub'))
  app.component('el-tooltip', passthrough('TooltipStub'))
  app.component('el-tag', passthrough('TagStub'))
  app.component('el-icon', passthrough('IconStub'))
  app.component('el-badge', empty('BadgeStub'))
  app.component('el-dialog', empty('DialogStub'))
  app.component('el-divider', empty('DividerStub'))
  const errors: unknown[] = []
  app.config.warnHandler = () => {}
  app.config.errorHandler = (err) => { errors.push(err) }
  app.mount(root as never)
  if (errors.length) throw errors[0]
  return { rootText: () => subtreeText(root) }
}

describe('SkillManager 系统技能内置标记（2026-11-20 内置技能方案 §6）', () => {
  it('builtin=true 的系统技能标「内置」，上传的系统技能标「系统」', async () => {
    const m = mount()
    await flush()
    expect(captured.gets).toContain('/skill-docs')
    const text = m.rootText()
    expect(text).toContain('内置技能随版本更新')
    expect(text).toContain('内置')
    expect(text).toContain('系统')
    // mao-cli 卡片：内置标记与名称相邻；team-skill 标「系统」
    expect(text).toContain('mao-cli')
    expect(text).toContain('team-skill')
  })
})
