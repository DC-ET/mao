// Node 环境无 DOM：.vue 在 vitest 下只编译出 ssrRender，手动编译模板补客户端 render，
// 再用无 DOM 渲染器提交登录表单（同 UsageFilterBar.test.ts 套路）。
// 覆盖登录失败的提示条数：HTTP 200 + code≠0 的业务失败响应拦截器已经弹过一次并打了
// toastShown 标记，登录页 catch 不得再弹第二条（曾一次失败弹两条）；只有拦截器静默的
// 失败（如 /auth/login 的 401）才由页面兜底展示。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Vue from 'vue'
import { h, nextTick, defineComponent, createRenderer } from 'vue'
import { parse, compileScript } from '@vue/compiler-sfc'
import { compile } from '@vue/compiler-dom'

vi.mock('vue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useSSRContext: () => ({ modules: new Set(), scopeId: null, styles: '' }),
  }
})

const captured = vi.hoisted(() => ({
  /** 页面自己弹的提示（拦截器那条不在本测试范围内，它由响应拦截器单测覆盖） */
  viewToasts: [] as string[],
  login: vi.fn(),
}))

vi.mock('element-plus', () => ({
  ElMessage: { error: (m: string) => captured.viewToasts.push(m) },
}))

vi.mock('@element-plus/icons-vue', async () => {
  const { h: hFn } = await import('vue')
  const icon = { render() { return hFn('i') } }
  return { Sunrise: icon, Moon: icon, Sunny: icon }
})

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn(async () => undefined) }),
}))

vi.mock('../../api', () => ({ api: { post: vi.fn(), get: vi.fn() } }))

// 只 stub 登录用到的三个成员；store 本身不是本用例的对象（它的回归在 useChat 等用例）
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({
    features: { passwordEnabled: true, feishuEnabled: false, ecpEnabled: false },
    login: captured.login,
    fetchAuthFeatures: vi.fn(async () => undefined),
  }),
}))

vi.mock('../../utils/theme', async () => {
  const { ref: refFn } = await import('vue')
  return { useTheme: () => ({ theme: refFn('light'), toggleTheme: () => {} }) }
})

vi.mock('../../utils/login-redirect', () => ({
  readRedirectQuery: () => null,
  safeRedirect: () => '/',
}))

vi.mock('../../utils/capacitor', () => ({
  isAndroidCapacitor: () => false,
  openExternalUrl: vi.fn(async () => false),
}))

vi.mock('../../utils/feishu-login-poll', () => ({
  feishuPollPhase: () => 'pending',
  openFeishuAuthPopup: () => null,
}))

vi.mock('../../utils/safe-storage', () => ({
  safeSetItem: vi.fn(),
  safeRemoveItem: vi.fn(),
}))

// setup 期读 localStorage、onMounted 写 document.title；node 环境都没有
vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
vi.stubGlobal('document', { title: '' })
vi.stubGlobal('window', {})

import LoginView from './LoginView.vue'

const descriptor = parse(readFileSync(new URL('./LoginView.vue', import.meta.url), 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'login-view' })
const compiled = compile(descriptor.template!.content, {
  mode: 'function',
  prefixIdentifiers: true,
  bindingMetadata: script.bindings,
})
const clientRender = new Function('Vue', compiled.code)(Vue) as (ctx: unknown, cache: unknown) => unknown

const ElForm = defineComponent({
  render() {
    const attrs = this.$attrs as Record<string, unknown>
    return h('form', {
      onSubmit: (e: { preventDefault?: () => void }) => {
        e?.preventDefault?.()
        const fn = attrs.onSubmit
        if (typeof fn === 'function') (fn as (ev: unknown) => void)(e)
      },
    }, this.$slots.default?.() ?? [])
  },
  methods: {
    validate: async () => true,
    clearValidate: () => {},
  },
})
const ElFormItem = defineComponent({ render() { return h('div', {}, this.$slots.default?.() ?? []) } })
/** v-model 走 modelValue + onUpdate:modelValue：把 setter 按 placeholder 记下来供用例填值 */
const inputSetters = new Map<string, (v: string) => void>()
const ElInput = defineComponent({
  props: { modelValue: { type: [String, Number], default: '' } },
  render() {
    const attrs = this.$attrs as Record<string, unknown>
    const placeholder = String(attrs.placeholder ?? '')
    const upd = attrs['onUpdate:modelValue']
    if (typeof upd === 'function') inputSetters.set(placeholder, upd as (v: string) => void)
    return h('input', { value: this.modelValue, placeholder })
  },
})
const ElCheckbox = defineComponent({
  props: { modelValue: { type: Boolean, default: false } },
  render() { return h('input', { type: 'checkbox', checked: this.modelValue }) },
})
const ElButton = defineComponent({
  props: { type: String, size: String, loading: Boolean },
  render() { return h('button', {}, this.$slots.default?.() ?? []) },
})

const LoginViewPanel = {
  ...(LoginView as object),
  components: {
    'el-form': ElForm, ElForm,
    'el-form-item': ElFormItem, ElFormItem,
    'el-input': ElInput, ElInput,
    'el-checkbox': ElCheckbox, ElCheckbox,
    'el-button': ElButton, ElButton,
  },
  render: clientRender,
}

interface StubEl { tag: string; children: StubNode[]; parent: StubEl | null; props: Record<string, unknown> }
type StubNode = StubEl | { text: string; parent: StubEl | null }

function nodeOps() {
  /** 元素 → 事件名 → 处理器；无 DOM 下手动 invoke（patchProp 收下所有 on*  prop） */
  const handlers = new Map<StubEl, Record<string, Array<(e?: unknown) => unknown>>>()
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
        if (!/^on[A-Z]/.test(key)) return
        const name = key.slice(2).toLowerCase()
        const fns = Array.isArray(next) ? next : [next]
        for (const fn of fns) {
          if (typeof fn !== 'function') continue
          const rec = handlers.get(el) ?? {}
          const arr = rec[name] ?? []
          arr.push(fn as (e?: unknown) => unknown)
          rec[name] = arr
          handlers.set(el, rec)
        }
      },
    },
  }
}

async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) { await Promise.resolve(); await nextTick() }
}

function mount() {
  const { ops, handlers } = nodeOps()
  const { createApp } = createRenderer(ops as never)
  const root = ops.createElement('root')
  const app = createApp(LoginViewPanel as never)
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
  return {
    /** 提交按钮是原生 submit，点它等于提交表单；这里直接触发表单 submit */
    submit: () => {
      const form = findAll(el => el.tag === 'form')[0]
      if (!form) throw new Error('form not found')
      const fn = handlers.get(form)?.submit?.slice(-1)[0]
      if (!fn) throw new Error('no submit handler')
      return fn({ preventDefault: () => {} })
    },
    setInput: (placeholder: string, value: string) => {
      const fn = inputSetters.get(placeholder)
      if (!fn) throw new Error(`input not found: ${placeholder}`)
      fn(value)
    },
  }
}

describe('LoginView 登录失败提示', () => {
  beforeEach(() => {
    captured.viewToasts.length = 0
    captured.login.mockReset()
  })

  it('密码错误（HTTP 200 + code≠0，拦截器已弹）页面不再重复弹第二条', async () => {
    const m = mount()
    await flush()
    m.setInput('用户名', 'yang')
    m.setInput('密码', 'wrong-pass')
    await flush()
    // 响应拦截器对业务失败的 reject 形态：纯 Error + toastShown（无 response）
    captured.login.mockRejectedValue(Object.assign(new Error('用户名或密码错误'), { toastShown: true, code: 1005 }))
    m.submit()
    await flush()
    expect(captured.viewToasts).toEqual([])
    expect(captured.login).toHaveBeenCalledWith('yang', 'wrong-pass')
  })

  it('网络错误（拦截器弹过「网络错误」）页面不追加提示', async () => {
    const m = mount()
    await flush()
    m.setInput('用户名', 'yang')
    m.setInput('密码', 'whatever')
    await flush()
    captured.login.mockRejectedValue(Object.assign(new Error('网络错误'), { toastShown: true }))
    m.submit()
    await flush()
    expect(captured.viewToasts).toEqual([])
  })

  it('拦截器静默的失败（401，无 toastShown）仍由页面兜底展示服务端文案', async () => {
    const m = mount()
    await flush()
    m.setInput('用户名', 'yang')
    m.setInput('密码', 'whatever')
    await flush()
    captured.login.mockRejectedValue({
      response: { data: { message: '未登录或登录已过期' } },
      message: 'Request failed with status code 401',
    })
    m.submit()
    await flush()
    expect(captured.viewToasts).toEqual(['未登录或登录已过期'])
  })
})
