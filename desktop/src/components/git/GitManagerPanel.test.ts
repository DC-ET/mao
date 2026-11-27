// GitManagerPanel 顶部刷新按钮回归（0.0.373）：
// 原「获取远端更新」文本按钮与变更工具栏 ↻ 合并为状态条上一个刷新图标——
// - 有远端：先显式 fetch --prune（run('fetch')，toast + 活动审计），再全量刷新
//   （仓库列表 + 远端状态 + 已加载的历史/分支/Stash 视图）；
// - 未配置远端：按钮仍可用，跳过 fetch 退化为纯本地刷新（对应原工具栏 ↻ 的能力，
//   原 fetch 按钮在该场景禁用，合并后不能丢失这个入口）；
// - 非 git 仓库：按钮禁用并直接在 title 说明原因。
// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue'
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
  selectedRepoPath: '',
  operationsProvider: null as any,
  tooltips: [] as string[],
  reposRef: null as { value: Array<{ path: string }> } | null,
  managerActiveView: null as { value: string } | null,
  initialManagerView: 'changes',
  selectedRepoPaths: [] as string[],
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
vi.mock('./GitBranchesView.vue', async () => {
  const { h } = await import('vue')
  return {
    default: {
      name: 'GitBranchesView',
      emits: ['switch'],
      setup(_: unknown, { emit }: { emit: (event: 'switch', name: string, create: boolean) => void }) {
        return () => h('button', {
          class: 'git-branch-switch-stub',
          onClick: () => emit('switch', 'main', false),
        }, 'switch-stub')
      },
    },
  }
})
vi.mock('./GitStashView.vue', () => ({ default: { name: 'GitStashView', render() { return null } } }))
vi.mock('./GitCompareView.vue', async () => {
  const { h } = await import('vue')
  return { default: { name: 'GitCompareView', render() { return h('div', { class: 'git-compare-stub' }) } } }
})

// ---- mock composables：真实实现返回 ref，mock 也要用真 ref（异步工厂里取 vue）----
vi.mock('../../composables/useGitRepos', async () => {
  const { ref } = await import('vue')
  const repos = ref<Array<{ path: string }>>([])
  state.reposRef = repos
  return {
    useGitRepos: () => ({
      repos,
      isRootGit: ref(state.isRootGit),
      multiRepoMode: ref(state.multiRepoMode),
      selectedRepoPath: ref(state.selectedRepoPath),
      selectedRepo: ref(null),
      // 仓库身份就绪（生产由 useGitRepos 计算）；缺省 true 让面板进入正常请求态
      requestReady: ref(true),
      refresh: async () => { state.refreshReposCalls += 1 },
      selectRepo: (path: string) => {
        state.selectedRepoPaths.push(path)
        return repos.value.some((repo) => repo.path === path)
      },
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
    useGitManager: () => {
      const activeView = ref(state.initialManagerView)
      state.managerActiveView = activeView
      return {
        // 真实实现里 activeView 是 ref：子导航点击会赋值，mock 也必须是 ref
        activeView,
        logEntries: [], logLoading: false, logError: '', logExhausted: false,
        expandedCommit: null, commitFiles: [], commitFilesLoading: false,
        loadMoreLog: async () => {}, retryLog: async () => {}, toggleCommit: async () => {},
        branches: [], branchesLoading: false, branchesError: '', loadBranches: async () => {},
        compareBase: ref(''), compareTarget: ref(''), compareResult: ref(null),
        compareLoading: ref(false), compareError: ref(''), loadCompare: async () => {},
        stashes: [], stashesLoading: false, stashesError: '', loadStashes: async () => {},
        remotes: ref([]), loadRemotes: async () => {},
        refreshLoadedViews: async () => { state.refreshLoadedViewsCalls += 1 },
      }
    },
  }
})

vi.mock('../../composables/useGitOperations', async () => {
  const { ref } = await import('vue')
  return {
    useGitOperations: (providerRef: any) => {
      state.operationsProvider = providerRef
      return {
        operation: ref(null),
        run: async (op: string) => {
          state.calls.push(op)
          return { success: true, message: '远端已更新' }
        },
      }
    },
  }
})

import GitManagerPanel from './GitManagerPanel.vue'

function mountPanel(events?: { onGitChanged?: () => void }, gitProvider: object = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(GitManagerPanel as any, {
      sessionId: 's1',
      gitProvider,
      onGitChanged: events?.onGitChanged,
    } as any),
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
  state.selectedRepoPath = ''
  state.operationsProvider = null
  state.tooltips = []
  state.selectedRepoPaths = []
  if (state.reposRef) state.reposRef.value = []
  state.initialManagerView = 'changes'
})

describe('GitManagerPanel 多仓库撤销', () => {
  it('多仓库包装把选中仓库的 repoPath 带给 discard，不会撤到工作区根仓库', async () => {
    state.status = { isGit: true, branch: 'main', hasRemote: false }
    state.multiRepoMode = true
    state.selectedRepoPath = 'sub-repo'
    const discard = vi.fn(async () => ({ success: true, operation: 'discard' }))
    const { app } = mountPanel(undefined, { discard })
    await state.operationsProvider.value.discard(null, 'digest-1')
    expect(discard).toHaveBeenCalledWith(null, 'digest-1', 'sub-repo')
    app.unmount()
  })
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

  it('远端徽标直接展示状态，不再弹出地址提示', () => {
    state.status = { ...fullStatus }
    const { host, app } = mountPanel()
    expect(host.querySelector('.git-remote-badge-text')?.textContent).toBe('远端可用')
    expect(state.tooltips.some((tip) => tip.includes('fetch:'))).toBe(false)
    app.unmount()

    state.tooltips = []
    state.status = { ...fullStatus, remoteStatusAvailable: false, remoteStatusError: '凭证失效' }
    const again = mountPanel()
    expect(again.host.querySelector('.git-remote-badge-text')?.textContent).toBe('凭证失效')
    expect(state.tooltips.some((tip) => tip.includes('fetch:'))).toBe(false)
    again.app.unmount()
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

// 对比视图入口（0.0.376）：子导航第五项「对比」，点击切到 GitCompareView。
describe('GitManagerPanel 分支切换同步侧边栏', () => {
  it('切换分支后发出 git-changed，让检查器重读当前分支', async () => {
    state.status = { isGit: true, branch: 'feat_cli_auto', hasRemote: true }
    let notified = 0
    const { host, app } = mountPanel({ onGitChanged: () => { notified += 1 } })
    const branchTab = [...host.querySelectorAll('.git-subnav-btn')]
      .find(b => (b.textContent || '').trim() === '分支') as HTMLButtonElement
    branchTab.click()
    await nextTick()
    ;(host.querySelector('.git-branch-switch-stub') as HTMLButtonElement).click()
    await settle()
    expect(state.calls).toEqual(['switch'])
    expect(notified).toBe(1)
    app.unmount()
  })
})

describe('GitManagerPanel 对比视图入口', () => {
  it('子导航含第五项「对比」，点击切到对比视图', async () => {
    const { host, app } = mountPanel()
    const labels = [...host.querySelectorAll('.git-subnav-btn')].map(b => (b.textContent || '').trim())
    expect(labels).toEqual(['变更', '历史', '分支', 'Stash', '对比'])

    const compareBtn = [...host.querySelectorAll('.git-subnav-btn')]
      .find(b => (b.textContent || '').trim() === '对比') as HTMLButtonElement
    compareBtn.click()
    await nextTick()
    expect(host.querySelector('.git-compare-stub')).not.toBeNull()
    app.unmount()
  })
})

describe('GitManagerPanel 摘要点仓库', () => {
  it('focusRepo 选中该仓库并回到变更视图；列表晚到时补选', async () => {
    state.reposRef!.value = []
    state.initialManagerView = 'history'
    const focusRepo = ref<{ path: string; nonce: number } | null>({ path: 'mao', nonce: 1 })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () => h(GitManagerPanel as any, {
        sessionId: 's1',
        gitProvider: {},
        focusRepo: focusRepo.value,
      }),
    })
    app.mount(host)
    await nextTick()
    expect(state.selectedRepoPaths).toEqual(['mao'])
    expect(state.managerActiveView!.value).toBe('history')

    state.reposRef!.value = [{ path: 'mao' }, { path: 'other' }]
    await nextTick()
    expect(state.selectedRepoPaths).toEqual(['mao', 'mao'])
    expect(state.managerActiveView!.value).toBe('changes')

    state.managerActiveView!.value = 'history'
    focusRepo.value = { path: 'other', nonce: 2 }
    await nextTick()
    expect(state.selectedRepoPaths.at(-1)).toBe('other')
    expect(state.managerActiveView!.value).toBe('changes')
    app.unmount()
  })
})
