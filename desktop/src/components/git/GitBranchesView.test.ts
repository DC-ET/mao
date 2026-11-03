// GitBranchesView 新建本地分支交互（0.0.415）：
// 「+ 新建分支」展开行内输入行 → isValidBranchName 实时校验（无效禁用创建并提示）
// → 确认 emit create-branch（trim 后的名字）并收起输入行。
// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { describe, expect, it, beforeEach } from 'vitest'
import GitBranchesView from './GitBranchesView.vue'
import type { GitBranchInfo } from '../../types/git'

const branches: GitBranchInfo[] = [
  { name: 'main', isCurrent: true, isRemote: false },
  { name: 'origin/main', isCurrent: false, isRemote: false, lastCommitHash: 'a'.repeat(40) },
]

function mountBranches() {
  const emitted: Array<{ event: string; args: unknown[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(GitBranchesView as any, {
      branches,
      onCreateBranch: (...args: unknown[]) => emitted.push({ event: 'create-branch', args }),
      onSwitch: (...args: unknown[]) => emitted.push({ event: 'switch', args }),
    }),
  })
  app.mount(host)
  return { host, app, emitted }
}

const createToggle = (host: HTMLElement) => host.querySelector('.git-branch-create-btn') as HTMLButtonElement | null
const createInput = (host: HTMLElement) => host.querySelector('.git-branch-create-input') as HTMLInputElement | null
const createConfirm = (host: HTMLElement) => host.querySelector('.git-branch-create-row .git-branch-switch') as HTMLButtonElement | null

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('GitBranchesView 新建本地分支', () => {
  it('展开输入行，合法分支名点击创建 emit trim 后的名字并收起输入行', async () => {
    const { host, app, emitted } = mountBranches()
    createToggle(host)!.click()
    await nextTick()

    const input = createInput(host)
    expect(input).not.toBeNull()
    input!.value = '  feat/demo  '
    input!.dispatchEvent(new Event('input'))
    await nextTick()
    expect(createConfirm(host)!.disabled).toBe(false)

    createConfirm(host)!.click()
    await nextTick()
    expect(emitted).toContainEqual({ event: 'create-branch', args: ['feat/demo'] })
    // 收起输入行并清空输入
    expect(createInput(host)).toBeNull()
    app.unmount()
  })

  it('非法分支名禁用创建并提示，Enter 也不 emit', async () => {
    const { host, app, emitted } = mountBranches()
    createToggle(host)!.click()
    await nextTick()

    const input = createInput(host)!
    input.value = 'bad..name'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    expect(createConfirm(host)!.disabled).toBe(true)
    expect((host.querySelector('.git-branch-create-error') as HTMLElement | null)?.textContent).toContain('分支名无效')

    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }))
    await nextTick()
    expect(emitted.filter((e) => e.event === 'create-branch')).toHaveLength(0)
    app.unmount()
  })

  it('合法分支名按 Enter 等价点击创建', async () => {
    const { host, app, emitted } = mountBranches()
    createToggle(host)!.click()
    await nextTick()

    const input = createInput(host)!
    input.value = 'feat/enter'
    input.dispatchEvent(new Event('input'))
    await nextTick()
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }))
    await nextTick()
    expect(emitted).toContainEqual({ event: 'create-branch', args: ['feat/enter'] })
    app.unmount()
  })

  it('再次点击「+ 新建分支」收起输入行（toggle）', async () => {
    const { host, app } = mountBranches()
    createToggle(host)!.click()
    await nextTick()
    expect(createInput(host)).not.toBeNull()
    createToggle(host)!.click()
    await nextTick()
    expect(createInput(host)).toBeNull()
    app.unmount()
  })
})
