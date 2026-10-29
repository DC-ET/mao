// GitManagerPanel 顶部刷新按钮回归（0.0.373）：
// 原「获取远端更新」文本按钮与变更工具栏 ↻ 合并为状态条上一个刷新图标——
// - 有远端：先显式 fetch --prune（run('fetch')，toast + 活动审计），再全量刷新
//   （仓库列表 + 远端状态 + 已加载的历史/分支/Stash 视图）；
// - 未配置远端：按钮仍可用，跳过 fetch 退化为纯本地刷新（对应原工具栏 ↻ 的能力，
//   原 fetch 按钮在该场景禁用，合并后不能丢失这个入口）；
// - 非 git 仓库：按钮禁用并直接在 title 说明原因。
// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  status: null as any,
  loading: false,
  calls: [] as string[],
  refreshReposCalls: 0,
  refreshRemoteCalls: 0,
  refreshLoadedViewsCalls: 0,
  isRootGit: false,
  multiRepoMode: false,
  tooltips: [] as string[],
}))

// element-plus 只桩到本组件用到的两件：ElMessage（toast）、ElTooltip（透传渲染，content 收集到 state.tooltips）
vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  ElTooltip: {
    name: 'ElTooltip',
    props: ['content'],
    setup(props: any, { slots }: any) {
      state.tooltips.push(props?.content ?? '')
      return () => slots.default?.() ?? null
    },
  },
}))

// ---- mock 子视图（断言只关心状态条按钮）----
vi.mock('../task/GitChangeList.vue', () => ({ default: { name: 'GitChangeList', render() { return null } } }))
vi.mock('./GitHistoryView.vue', () => ({ default: { name: 'GitHistoryView', render() { return null } } }))
vi.mock('./GitBranchesView.vue', () => ({ default: { name: 'GitBranchesView', render() { return null } } }))
vi.mock('./GitStashView.vue', () => ({ default: { name: 'GitStashView', render() { return null } } }))

// ---- mock composables：真实实现返回 ref，mock 也要用真 ref（异步工厂里取 vue）----
vi.mock('../../composables/useGitRepos', async () => {
  const { ref } = await import('vue')
  return {
    useGitRepos: () => ({
      repos: ref([]),
      isRootGit: ref(state.isRootGit),
      multiRepoMode: ref(state.multiRepoMode),
      selectedRepoPath: ref(''),
      selectedRepo: ref(null),
      refresh: async () => { state.refreshReposCalls += 1 },
      selectRepo: () => {},
    }),
  }
})

vi.mock('../../composables/useGitStatus', async () => {
  const { ref } = await import('vue')
  return {
    useGitStatus: () => ({
      loading: ref(state.loading),
      error: ref(null),
      status: ref(state.status),
      files: ref([]),
      remoteLoading: ref(false),
      refreshRemote: async () => { state.refreshRemoteCalls += 1 },
      refreshWithRemoteConfirmation: async () => { state.refreshRemoteCalls += 1 },
    }),
  }
})

vi.mock('../../composables/useGitManager', async () => {
  const { ref } = await import('vue')
  return {
    useGitManager: () => ({
      activeView: 'changes',
      logEntries: [], logLoading: false, logError: '', logExhausted: false,
      expandedCommit: null, commitFiles: [], commitFilesLoading: false,
      loadMoreLog: async () => {}, retryLog: async () => {}, toggleCommit: async () => {},
      branches: [], branchesLoading: false, branchesError: '', loadBranches: async () => {},
      stashes: [], stashesLoading: false, stashesError: '', loadStashes: async () => {},
      remotes: ref([]), loadRemotes: async () => {},
      refreshLoadedViews: async () => { state.refreshLoadedViewsCalls += 1 },
    }),
  }
})

vi.mock('../../composables/useGitOperations', async () => {
  const { ref } = await import('vue')
  return {
    useGitOperations: () => ({
      operation: ref(null),
      run: async (op: string) => {
        state.calls.push(op)
        return { success: true, message: '远端已更新' }
      },
    }),
  }
})

import GitManagerPanel from './GitManagerPanel.vue'

function mountPanel() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(GitManagerPanel as any, { sessionId: 's1', gitProvider: {} } as any),
  })
  app.mount(host)
  return { host, app }
}

const statusBtn = (host: HTMLElement, label: string) =>
  host.querySelector(`button.git-status-btn[aria-label="${label}"]`) as HTMLButtonElement | null

const refreshBtn = (host: HTMLElement) => statusBtn(host, '刷新 Git 状态')

/** 点击后链路是多段 await（fetch → 仓库列表 → 远端状态 → 视图），多轮宏任务排空 */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  document.body.innerHTML = ''
  state.status = null
  state.loading = false
  state.calls = []
  state.refreshReposCalls = 0
  state.refreshRemoteCalls = 0
  state.refreshLoadedViewsCalls = 0
  state.isRootGit = false
  state.multiRepoMode = false
  state.tooltips = []
})

describe('GitManagerPanel 顶部刷新按钮', () => {
  it('有远端：点击先显式 fetch --prune，再全量刷新各面板', async () => {
    state.status = { isGit: true, branch: 'main', hasRemote: true }
    const { host, app } = mountPanel()
    const btn = refreshBtn(host)!
    expect(btn.disabled).toBe(false)
    expect(btn.title).toContain('fetch --prune')

    btn.click()
    await settle()
    expect(state.calls).toEqual(['fetch'])
    expect(state.refreshReposCalls).toBe(1)
    expect(state.refreshRemoteCalls).toBe(1)
    expect(state.refreshLoadedViewsCalls).toBe(1)
    app.unmount()
  })

  it('未配置远端：按钮可用，点击只做本地刷新不 fetch', async () => {
    state.status = { isGit: true, branch: 'main', hasRemote: false }
    const { host, app } = mountPanel()
    const btn = refreshBtn(host)!
    expect(btn.disabled).toBe(false)
    expect(btn.title).toBe('刷新 Git 状态')

    btn.click()
    await settle()
    expect(state.calls).toEqual([])
    expect(state.refreshReposCalls).toBe(1)
    expect(state.refreshRemoteCalls).toBe(1)
    expect(state.refreshLoadedViewsCalls).toBe(1)
    app.unmount()
  })

  it('非 git 仓库：按钮禁用并说明原因', () => {
    state.status = { isGit: false }
    const { host, app } = mountPanel()
    const btn = refreshBtn(host)!
    expect(btn.disabled).toBe(true)
    expect(btn.title).toBe('当前目录不是 Git 仓库')
    app.unmount()
  })
})

// 仓库区显隐回归（0.0.375）：工作区自身即 git 仓库时（isRootGit，后端不再扫子目录），
// 它是唯一仓库，顶部徽章只是重复工作区名——整行不渲染；仅多仓库工作区
// （工作区非 git、一级子目录含 git 仓库）才渲染仓库下拉选择器。
describe('GitManagerPanel 仓库区显隐', () => {
  it('工作区自身即 git 仓库：不渲染仓库徽章行', () => {
    state.status = { isGit: true, branch: 'main', hasRemote: true, repoRoot: '/ws/mao' }
    state.isRootGit = true
    const { host, app } = mountPanel()
    expect(host.querySelector('.git-repo-badge-row')).toBeNull()
    app.unmount()
  })

  it('多仓库工作区：仍渲染仓库下拉选择行', () => {
    state.status = { isGit: true, branch: 'dev', hasRemote: true }
    state.multiRepoMode = true
    const { host, app } = mountPanel()
    expect(host.querySelector('.git-repo-select-row')).not.toBeNull()
    expect(host.querySelector('.git-repo-badge-row')).toBeNull()
    app.unmount()
  })
})

// 同步入口上移回归（0.0.376）：拉取 / 推送从变更工具栏收敛到顶部状态条，与 ↻ 并排，
// 禁用原因与侧边栏工具栏同一口径（utils/git-manager 的 gitPull/gitPushDisabledReason）。
describe('GitManagerPanel 顶部拉取 / 推送按钮', () => {
  const fullStatus = {
    isGit: true,
    branch: 'main',
    hasRemote: true,
    remoteStatusAvailable: true,
    upstream: 'origin/main',
    behindCount: 2,
    hasHead: true,
    hasCommitsToPush: true,
  }

  it('状态条上拉取 / 推送 / 刷新三个图标按钮并排，均在 git 仓库时渲染', () => {
    state.status = { ...fullStatus }
    const { host, app } = mountPanel()
    const labels = [...host.querySelectorAll('.git-status-actions button')].map((b) => b.getAttribute('aria-label'))
    expect(labels).toEqual(['拉取代码', '推送代码', '刷新 Git 状态'])
    app.unmount()
  })

  it('点击拉取 / 推送触发对应写操作，并带一次全量刷新', async () => {
    state.status = { ...fullStatus }
    const { host, app } = mountPanel()
    statusBtn(host, '拉取代码')!.click()
    await settle()
    statusBtn(host, '推送代码')!.click()
    await settle()
    expect(state.calls).toEqual(['pull', 'push'])
    expect(state.refreshReposCalls).toBe(2)
    expect(state.refreshLoadedViewsCalls).toBe(2)
    app.unmount()
  })

  it('没有可拉取更新 / 无可推送提交时按钮禁用并说明原因', () => {
    state.status = { ...fullStatus, behindCount: 0, hasCommitsToPush: false }
    const { host, app } = mountPanel()
    const pull = statusBtn(host, '拉取代码')!
    const push = statusBtn(host, '推送代码')!
    expect(pull.disabled).toBe(true)
    expect(push.disabled).toBe(true)
    expect(state.tooltips).toContain('没有可拉取的更新')
    expect(state.tooltips).toContain('没有可推送的提交')
    app.unmount()
  })

  it('未配置 upstream / 远端状态未确认时按钮禁用并说明原因', () => {
    state.status = { ...fullStatus, upstream: undefined, remoteStatusAvailable: false, remoteStatusError: 'fetch 失败' }
    const { host, app } = mountPanel()
    const pull = statusBtn(host, '拉取代码')!
    const push = statusBtn(host, '推送代码')!
    expect(pull.disabled).toBe(true)
    expect(push.disabled).toBe(true)
    expect(state.tooltips).toContain('fetch 失败')
    app.unmount()
  })

  it('非 git 仓库：同步按钮不渲染，刷新按钮仍在并禁用说明原因', () => {
    state.status = { isGit: false }
    const { host, app } = mountPanel()
    for (const label of ['拉取代码', '推送代码']) {
      expect(statusBtn(host, label), label).toBeNull()
    }
    const refresh = refreshBtn(host)!
    expect(refresh.disabled).toBe(true)
    expect(refresh.title).toBe('当前目录不是 Git 仓库')
    app.unmount()
  })
})
