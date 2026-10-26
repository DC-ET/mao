// OnboardingOverlay 步骤 1「选智能体」的详情请求代际守卫。
// 连点两个智能体卡片时，两个 /agents/:id 请求并发在飞；先发的那个后返回，
// 不得把后选中智能体的推荐问题覆写成先点那个的（曾无代际判断，直接赋值）。
// 推荐问题不直接渲染，用户可见路径是：选中 → 下一步 → 下一步，示例任务被预填。
// @vitest-environment jsdom
import { createApp, defineComponent, h } from 'vue'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Agent } from '../../stores/agent'

interface Deferred {
  id: string
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const { inflight } = vi.hoisted(() => ({ inflight: [] as Array<{ id: string; resolve: (v: unknown) => void; reject: (e: unknown) => void }> }))

vi.mock('../../api', () => ({
  api: {
    get: vi.fn((url: string) => {
      const id = url.split('/').pop() as string
      return new Promise((resolve, reject) => {
        inflight.push({ id, resolve, reject })
      })
    }),
  },
}))

import OnboardingOverlay from './OnboardingOverlay.vue'

/** element-plus 组件只做可点/可绑定的最小替身，断言走原生 DOM */
function mountOverlay(agents: Agent[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(OnboardingOverlay as never, {
        agents,
        agentsLoading: false,
        onComplete: () => {},
        onSkip: () => {},
      } as never),
  })
  // 子组件模板里的 el-* 走全局解析：根组件 options.components 不是全局注册
  app.component('ElAvatar', { render: () => h('span', { class: 'el-avatar-stub' }) })
  app.component('ElTag', { render: () => h('span', { class: 'el-tag-stub' }) })
  app.component('ElInput', defineComponent({
    props: { modelValue: { type: String, default: '' } },
    render() { return h('textarea', { class: 'el-input-stub', value: this.modelValue }) },
  }))
  app.component('ElButton', defineComponent({
    props: { disabled: { type: Boolean, default: false } },
    render() { return h('button', { class: 'el-button-stub', disabled: this.disabled }, this.$slots.default?.() ?? []) },
  }))
  app.mount(host)
  return { host, app }
}

const agent = (id: string, name: string): Agent => ({
  id,
  name,
  description: `${name} 描述`,
  executionMode: 'CLOUD',
})

const cards = (host: HTMLElement) => Array.from(host.querySelectorAll('.agent-card')) as HTMLElement[]
const sampleInput = (host: HTMLElement) => host.querySelector('.el-input-stub') as HTMLTextAreaElement | null
const nextBtn = (host: HTMLElement) =>
  Array.from(host.querySelectorAll('.el-button-stub')).find((b) => b.textContent?.includes('下一步')) as
    | HTMLElement
    | undefined

/** 推两步到步骤 3：选中态下点「下一步」，示例任务被推荐问题预填 */
async function goToSampleStep(host: HTMLElement) {
  nextBtn(host)!.click()
  await Promise.resolve()
  await Promise.resolve()
  nextBtn(host)!.click()
  await Promise.resolve()
  await Promise.resolve()
}

function deferredFor(id: string): Deferred {
  const found = inflight.find((d) => d.id === id)
  if (!found) throw new Error(`没有 id=${id} 的在飞请求：${JSON.stringify(inflight.map((d) => d.id))}`)
  return found
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  document.body.innerHTML = ''
  inflight.length = 0
})

describe('OnboardingOverlay selectAgent 请求代际', () => {
  it('连点两个智能体：先发后到的详情响应不覆写后选中智能体的推荐问题', async () => {
    const { host, app } = mountOverlay([agent('1', '甲'), agent('2', '乙')])
    cards(host)[0].click()
    cards(host)[1].click()
    expect(inflight.map((d) => d.id)).toEqual(['1', '2'])

    // 后点先返回、先点后返回（乱序到达）
    deferredFor('2').resolve({ data: { suggestedQuestions: [{ content: '乙的问题' }] } })
    await flush()
    deferredFor('1').resolve({ data: { suggestedQuestions: [{ content: '甲的问题' }] } })
    await flush()

    await goToSampleStep(host)
    // 仍是后选中智能体（乙）的推荐问题，没有被过期响应写成「甲的问题」
    expect(sampleInput(host)!.value).toBe('乙的问题')
    app.unmount()
  })

  it('先点智能体的详情请求失败不得清空后选中智能体的推荐问题', async () => {
    const { host, app } = mountOverlay([agent('1', '甲'), agent('2', '乙')])
    cards(host)[0].click()
    cards(host)[1].click()

    deferredFor('2').resolve({ data: { suggestedQuestions: [{ content: '乙的问题' }] } })
    await flush()
    // 过期代际失败：只应被丢弃
    deferredFor('1').reject(new Error('boom'))
    await flush()

    await goToSampleStep(host)
    expect(sampleInput(host)!.value).toBe('乙的问题')
    app.unmount()
  })

  it('当前选中智能体详情失败：回退内置示例任务，不空白', async () => {
    const { host, app } = mountOverlay([agent('1', '甲')])
    cards(host)[0].click()
    deferredFor('1').reject(new Error('boom'))
    await flush()

    await goToSampleStep(host)
    expect(sampleInput(host)!.value).toContain('搜一下本周 AI 领域的重要新闻')
    app.unmount()
  })
})
