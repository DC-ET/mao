// 变更清单的两套提交交互分界（0.0.372）：
// - 侧边栏（默认）：工具栏 ✓ 一步提交，点击 emit commit，无提交信息框；
// - 中央 Git 管理器（twoStepCommit）：工具栏 ✓ 让位给提交信息框——
//   多行输入 + ✨ LLM 生成 + 提交按钮；空消息禁用提交；生成中 ✨ 禁用；提交中按钮禁用；
//   没有待提交变更时整个提交框不渲染。
// @vitest-environment jsdom
import { createApp, h, nextTick, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'

// element-plus 只桩到本组件用到的三件：ElMessage（toast）、ElTooltip / ElDialog（透传渲染）
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  ElTooltip: { name: 'ElTooltip', setup(_props: unknown, { slots }: any) { return () => slots.default?.() ?? null } },
  ElDialog: { name: 'ElDialog', setup() { return () => null } },
}))

import GitChangeList from './GitChangeList.vue'

const files = [
  { path: 'a.txt', changeType: 'MODIFIED', insertions: 3, deletions: 1 },
  { path: 'src/b.ts', changeType: 'CREATED', insertions: 10, deletions: 0 },
]

function mountComponent(props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = reactive({ commitMessage: '' })
  const listeners = {
    onCommit: vi.fn(),
    onGenerateCommitMessage: vi.fn(),
    onCommitWithMessage: vi.fn(),
  }
  const app = createApp({
    setup() {
      return { state, files, listeners }
    },
    render() {
      return h(GitChangeList as any, {
        files,
        ...props,
        commitMessage: state.commitMessage,
        'onUpdate:commit-message': (value: string) => { state.commitMessage = value },
        ...listeners,
      } as any)
    },
  })
  app.mount(host)
  return { host, state, listeners, app }
}

function q(host: HTMLElement, selector: string) {
  return host.querySelector(selector) as HTMLElement | null
}

describe('GitChangeList 提交交互', () => {
  it('侧边栏模式：工具栏 ✓ 一步提交，无提交信息框', async () => {
    const { host, listeners, app } = mountComponent()
    const commitBtn = q(host, '.git-action-btn[aria-label="提交代码"]')
    expect(commitBtn).toBeTruthy()
    expect(q(host, '.git-commit-box')).toBeNull()

    commitBtn!.click()
    await nextTick()
    expect(listeners.onCommit).toHaveBeenCalled()
    app.unmount()
  })

  it('两步模式：工具栏 ✓ 隐藏，提交信息框替代它', async () => {
    const { host, app } = mountComponent({ twoStepCommit: true })
    expect(q(host, '.git-action-btn[aria-label="提交代码"]')).toBeNull()
    expect(q(host, '.git-commit-box')).toBeTruthy()
    expect(q(host, 'textarea.git-commit-input')).toBeTruthy()
    expect(q(host, '.git-commit-generate')).toBeTruthy()
    expect(q(host, '.git-commit-submit')).toBeTruthy()
    app.unmount()
  })

  it('两步模式：空消息禁用提交，输入后启用并带上消息提交', async () => {
    const { host, state, listeners, app } = mountComponent({ twoStepCommit: true })
    const submit = q(host, '.git-commit-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    const textarea = q(host, 'textarea.git-commit-input') as HTMLTextAreaElement
    textarea.value = 'wip 随手一改\n\n第二段'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    expect(state.commitMessage).toBe('wip 随手一改\n\n第二段')
    expect(submit.disabled).toBe(false)

    submit.click()
    await nextTick()
    expect(listeners.onCommitWithMessage).toHaveBeenCalled()
    app.unmount()
  })

  it('两步模式：点 ✨ 触发生成；生成中 ✨ 禁用', async () => {
    const { host, listeners, app } = mountComponent({ twoStepCommit: true })
    const generate = q(host, '.git-commit-generate') as HTMLButtonElement

    generate.click()
    await nextTick()
    expect(listeners.onGenerateCommitMessage).toHaveBeenCalled()
    expect(generate.disabled).toBe(false)

    const generating = mountComponent({ twoStepCommit: true, generating: true })
    const generatingBtn = q(generating.host, '.git-commit-generate') as HTMLButtonElement
    expect(generatingBtn.disabled).toBe(true)
    generating.app.unmount()
    app.unmount()
  })

  it('两步模式：提交进行中禁用提交按钮', async () => {
    const { host, app } = mountComponent({ twoStepCommit: true, committing: true })
    const submit = q(host, '.git-commit-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    app.unmount()
  })

  it('两步模式：没有待提交变更时整个提交框不渲染', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(GitChangeList as any, { files: [], twoStepCommit: true } as any),
    })
    app.mount(host)
    expect(q(host, '.git-commit-box')).toBeNull()
    expect(host.textContent).toContain('没有待提交的变更')
    app.unmount()
  })
})
