// 撤销改动入口（技术方案 2026-11-23）：只有中央 Git 管理器传 allowDiscard；
// 「撤销全部」/ 文件行按钮都先确认，确认才发 discard，取消不发；「全部」附确认清单的摘要。
// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const confirm = vi.hoisted(() => vi.fn())

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  ElMessageBox: { confirm },
  ElTooltip: { name: 'ElTooltip', setup(_props: unknown, { slots }: any) { return () => slots.default?.() ?? null } },
  ElDialog: { name: 'ElDialog', setup() { return () => null } },
}))

import GitChangeList from './GitChangeList.vue'
import { gitDiscardDigest } from '../../utils/git-manager'

const files = [
  { path: 'a.txt', changeType: 'MODIFIED', insertions: 3, deletions: 1 },
  { path: 'shots/zhihu-home.png', changeType: 'CREATED', untracked: true, insertions: 0, deletions: 0, binary: true },
]

function mount(props: Record<string, unknown> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const onDiscard = vi.fn()
  const app = createApp({
    render: () => h(GitChangeList as any, { files, twoStepCommit: true, onDiscard, ...props }),
  })
  app.mount(host)
  return { host, onDiscard, app }
}

const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
  confirm.mockReset()
})

describe('GitChangeList 撤销改动', () => {
  it('不传 allowDiscard：没有撤销全部按钮，也没有文件行撤销按钮', () => {
    const { host, app } = mount()
    expect(host.querySelector('.git-discard-all')).toBeNull()
    expect(host.querySelector('.git-discard-btn')).toBeNull()
    app.unmount()
  })

  it('撤销全部：确认后发出 discard(null, 清单摘要)', async () => {
    confirm.mockResolvedValue('confirm')
    const { host, onDiscard, app } = mount({ allowDiscard: true })
    ;(host.querySelector('.git-discard-all') as HTMLButtonElement).click()
    await settle()
    expect(confirm.mock.calls[0][0]).toContain('将撤销全部 2 个文件的未提交改动')
    expect(confirm.mock.calls[0][2]).toMatchObject({ confirmButtonText: '撤销' })
    expect(onDiscard).toHaveBeenCalledWith(null, await gitDiscardDigest(['a.txt', 'shots/zhihu-home.png']))
    app.unmount()
  })

  it('取消确认不发请求', async () => {
    confirm.mockRejectedValue('cancel')
    const { host, onDiscard, app } = mount({ allowDiscard: true })
    ;(host.querySelector('.git-discard-all') as HTMLButtonElement).click()
    await settle()
    expect(onDiscard).not.toHaveBeenCalled()
    app.unmount()
  })

  it('文件行按钮带 aria-label，确认后只撤这一个文件；Agent 运行中确认框追加提示', async () => {
    confirm.mockResolvedValue('confirm')
    const { host, onDiscard, app } = mount({ allowDiscard: true, agentRunning: true })
    await nextTick()
    const btn = host.querySelector('.git-discard-btn[aria-label="撤销 a.txt 的改动"]') as HTMLButtonElement
    expect(btn).toBeTruthy()
    btn.click()
    await settle()
    expect(confirm.mock.calls[0][0]).toBe('将撤销「a.txt」的未提交改动。此操作无法恢复。Agent 正在运行，可能仍在修改这些文件。')
    expect(onDiscard).toHaveBeenCalledWith(['a.txt'])
    app.unmount()
  })

  it('撤销进行中：撤销与提交按钮都禁用并说明原因', () => {
    const { host, app } = mount({ allowDiscard: true, discarding: true, commitMessage: 'x' })
    const all = host.querySelector('.git-toolbar .git-discard-all[aria-label="撤销全部未提交改动"]') as HTMLButtonElement
    expect(all.disabled).toBe(true)
    expect((host.querySelector('.git-commit-submit') as HTMLButtonElement).disabled).toBe(true)
    expect((host.querySelector('.git-discard-btn') as HTMLButtonElement).title).toBe('撤销进行中')
    app.unmount()
  })
})
