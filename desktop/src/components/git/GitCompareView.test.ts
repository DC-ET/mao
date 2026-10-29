// GitCompareView 两点语义 UI 回归（0.0.376）：
// 1. 汇总条必须标明方向 `base → target`（两点语义下左侧独有改动会呈现为反向修改，方向标注是解释成本的核心；
//    断言锁「main→feature 连续文本 + 反向形态不出现」，防方向互换的静默回归）；
// 2. 空列表文案为「两个分支当前内容完全一致」（两点为空 = 两棵树内容一致，含历史不同但内容相同）；
// 3. 「仅基准分支」标记必须落在 DELETED 行且紧跟文件名（嵌套目录递归透传）——锁「哪一行」而非只锁数量；
// 4. 不传 deletedTag 的 GitChangeTreeNode（变更视图 / 提交 diff 口径）不渲染标记元素（防守卫被移除后出现空 chip）；
// 5. 点文件 open-diff 的 payload 是 diff tab id `git-branch-diff:<base>-><target>:` 的唯一来源，一并锁定。
// @vitest-environment jsdom
import { createApp, type App, type Component } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GitCompareView from './GitCompareView.vue'
import GitChangeTreeNode from '../task/GitChangeTreeNode.vue'
import type { GitBranchCompareResult, GitBranchInfo, GitChangedFile, GitTreeNode } from '../../types/git'

const branches: GitBranchInfo[] = [
  { name: 'main', isCurrent: true, isRemote: false },
  { name: 'feature', isCurrent: false, isRemote: false },
  { name: 'origin/main', isCurrent: false, isRemote: true },
]

function file(path: string, changeType: GitChangedFile['changeType'], extra: Partial<GitChangedFile> = {}): GitChangedFile {
  return { path, changeType, insertions: 1, deletions: 1, ...extra }
}

function result(files: GitChangedFile[]): GitBranchCompareResult {
  return { base: 'main', target: 'feature', aheadCount: 2, behindCount: 1, files }
}

const mounted: Array<{ app: App; el: HTMLElement }> = []

afterEach(() => {
  for (const { app, el } of mounted.splice(0)) {
    app.unmount()
    el.remove()
  }
})

function mount(component: Component, props: Record<string, unknown>) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(component, props)
  app.mount(el)
  mounted.push({ app, el })
  return { app, el }
}

function mountCompare(r: GitBranchCompareResult, extra: Record<string, unknown> = {}) {
  return mount(GitCompareView, {
    branches,
    branchesLoading: false,
    branchesError: '',
    compareBase: 'main',
    compareTarget: 'feature',
    compareResult: r,
    compareLoading: false,
    compareError: '',
    ...extra,
  })
}

describe('GitCompareView（两点语义）', () => {
  it('汇总条标注方向 base → target（顺序不可反）与领先 / 落后、文件数、总增删', () => {
    const { el } = mountCompare(result([file('src/a.ts', 'MODIFIED'), file('b.ts', 'CREATED')]))
    const text = el.textContent || ''
    expect(text).toContain('main→feature')
    expect(text).not.toContain('feature→main')
    expect(text).toContain('↑2 领先')
    expect(text).toContain('↓1 落后')
    expect(text).toContain('2 个文件')
    expect(text).toContain('+2')
    expect(text).toContain('-2')
  })

  it('空列表提示「两个分支当前内容完全一致」', () => {
    const { el } = mountCompare(result([]))
    expect(el.textContent).toContain('两个分支当前内容完全一致')
  })

  it('「仅基准分支」标记：落在 DELETED 行且紧跟文件名，嵌套目录递归透传', () => {
    const files = [
      file('base-only.ts', 'DELETED'),
      file('src/nested/also-base-only.ts', 'DELETED'),
      file('target-new.ts', 'CREATED'),
      file('shared.ts', 'MODIFIED'),
      file('renamed-new.ts', 'RENAMED', { oldPath: 'renamed-old.ts' }),
    ]
    const { el } = mountCompare(result(files))
    const text = el.textContent || ''
    // 标记恰出现 2 次，且必须紧跟各自 DELETED 文件名（锁「哪一行」，防判定反转后标记落到 CREATED/MODIFIED 行）
    expect(text.split('仅基准分支').length - 1).toBe(2)
    expect(text).toContain('base-only.ts仅基准分支')
    expect(text).toContain('also-base-only.ts仅基准分支')
    expect(text).not.toContain('target-new.ts仅基准分支')
    expect(text).not.toContain('shared.ts仅基准分支')
    expect(text).not.toContain('renamed-new.ts仅基准分支')
  })

  it('不传 deletedTag 的 GitChangeTreeNode（变更视图口径）不渲染标记元素', () => {
    const node: GitTreeNode = {
      kind: 'file',
      name: 'gone.ts',
      path: 'gone.ts',
      file: file('gone.ts', 'DELETED'),
    }
    const { el } = mount(GitChangeTreeNode, { node, depth: 0, collapsed: new Set<string>() })
    expect(el.textContent).toContain('gone.ts')
    expect(el.textContent).not.toContain('仅基准分支')
    // 锁「元素不渲染」（防 `&& deletedTag` 守卫被移除后出现空 chip）
    expect(el.querySelectorAll('.git-file-tag').length).toBe(0)
  })

  it('点文件 emit open-diff，payload 携带 base / target / file', () => {
    const onOpenDiff = vi.fn()
    const { el } = mountCompare(result([file('base-only.ts', 'DELETED')]), { onOpenDiff })
    const rows = Array.from(el.querySelectorAll<HTMLElement>('.git-node-row'))
    const row = rows.find((r) => r.textContent?.includes('base-only.ts'))
    expect(row).toBeTruthy()
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onOpenDiff).toHaveBeenCalledTimes(1)
    expect(onOpenDiff.mock.calls[0][0]).toMatchObject({
      base: 'main',
      target: 'feature',
      file: { path: 'base-only.ts', changeType: 'DELETED' },
    })
  })

  it('交换按钮成对 emit update:compareBase / update:compareTarget（两点方向的纠偏入口）', () => {
    const onBase = vi.fn()
    const onTarget = vi.fn()
    const { el } = mountCompare(result([]), {
      'onUpdate:compareBase': onBase,
      'onUpdate:compareTarget': onTarget,
    })
    const swap = el.querySelector<HTMLButtonElement>('.git-compare-swap')
    expect(swap).toBeTruthy()
    swap!.click()
    expect(onBase).toHaveBeenCalledWith('feature')
    expect(onTarget).toHaveBeenCalledWith('main')
  })

  it('未选满两个分支时提示选择', () => {
    const { el } = mount(GitCompareView, {
      branches,
      branchesLoading: false,
      branchesError: '',
      compareBase: 'main',
      compareTarget: '',
      compareResult: null,
      compareLoading: false,
      compareError: '',
    })
    expect(el.textContent).toContain('请选择两个分支开始对比')
  })
})
