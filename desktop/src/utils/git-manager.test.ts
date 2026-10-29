import { describe, expect, it } from 'vitest'
import {
  buildGitTree,
  collectDirPaths,
  formatRelativeTime,
  gitPullDisabledReason,
  gitPushDisabledReason,
  gitSyncDisabledReason,
  isValidBranchName,
  isValidStashRef,
  parseBranchLine,
  parseRefsDecorations,
  parseStashLine,
  sanitizeRemoteUrl,
} from './git-manager'
import type { GitChangedFile } from '../types/git'

describe('parseRefsDecorations', () => {
  it('拆分 HEAD -> main、远端与 tag 并分类', () => {
    const refs = parseRefsDecorations('HEAD -> main, origin/main, tag: v1.0', ['origin'])
    expect(refs).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1.0' },
    ])
  })

  it('无 remotes 参数时含 / 的段按 remote 兜底', () => {
    expect(parseRefsDecorations('HEAD -> feature/x, origin/feature/x')).toEqual([
      { kind: 'head', name: 'feature/x' },
      { kind: 'remote', name: 'origin/feature/x' },
    ])
  })

  it('remotes 已知时本地分支的斜杠不误判为 remote', () => {
    expect(parseRefsDecorations('feature/x', ['origin'])).toEqual([{ kind: 'branch', name: 'feature/x' }])
  })

  it('空值与纯 HEAD', () => {
    expect(parseRefsDecorations(undefined)).toEqual([])
    expect(parseRefsDecorations('')).toEqual([])
    expect(parseRefsDecorations('HEAD')).toEqual([{ kind: 'head', name: 'HEAD' }])
  })
})

describe('parseBranchLine', () => {
  it('解析当前分支、upstream 与 ahead/behind', () => {
    const parsed = parseBranchLine('* main abc1234 [origin/main: ahead 2, behind 3] latest subject')
    expect(parsed).toEqual({
      name: 'main',
      isCurrent: true,
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      lastCommitHash: 'abc1234',
      lastCommitTitle: 'latest subject',
    })
  })

  it('无 upstream、无 ahead/behind', () => {
    const parsed = parseBranchLine('  feature def5678 some work')
    expect(parsed).toEqual({
      name: 'feature',
      isCurrent: false,
      upstream: undefined,
      ahead: undefined,
      behind: undefined,
      lastCommitHash: 'def5678',
      lastCommitTitle: 'some work',
    })
  })

  it('gone 跟踪态保留 upstream 名但不解析 ahead/behind', () => {
    // git branch -vv 实测输出：`  side 6d39768 [origin/side: gone] side`
    const parsed = parseBranchLine('  side 6d39768 [origin/side: gone] side')
    expect(parsed?.upstream).toBe('origin/side')
    expect(parsed?.ahead).toBeUndefined()
    expect(parsed?.behind).toBeUndefined()
  })

  it('空仓库未出生分支无 hash', () => {
    const parsed = parseBranchLine('* main')
    expect(parsed?.name).toBe('main')
    expect(parsed?.isCurrent).toBe(true)
    expect(parsed?.lastCommitHash).toBeUndefined()
    expect(parsed?.lastCommitTitle).toBeUndefined()
  })

  it('空行返回 null', () => {
    expect(parseBranchLine('')).toBeNull()
    expect(parseBranchLine('   ')).toBeNull()
  })
})

describe('parseStashLine', () => {
  it('NUL 分隔解析 ref/message/date', () => {
    const parsed = parseStashLine(`stash@{0}\u0000On branch main: mao-auto-pull-abc\u00002026-10-28T10:00:00+08:00`)
    expect(parsed).toEqual({
      ref: 'stash@{0}',
      message: 'On branch main: mao-auto-pull-abc',
      date: '2026-10-28T10:00:00+08:00',
    })
  })

  it('缺字段时兜底空串', () => {
    expect(parseStashLine('stash@{0}')).toEqual({ ref: 'stash@{0}', message: '', date: '' })
    expect(parseStashLine('')).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-10-28T12:00:00+08:00')

  it('按跨度给中文相对时间', () => {
    expect(formatRelativeTime('2026-10-28T11:59:40+08:00', now)).toBe('刚刚')
    expect(formatRelativeTime('2026-10-28T11:30:00+08:00', now)).toBe('30 分钟前')
    expect(formatRelativeTime('2026-10-28T09:00:00+08:00', now)).toBe('3 小时前')
    expect(formatRelativeTime('2026-10-25T12:00:00+08:00', now)).toBe('3 天前')
    expect(formatRelativeTime('2026-08-28T12:00:00+08:00', now)).toBe('2 个月前')
    expect(formatRelativeTime('2024-10-28T12:00:00+08:00', now)).toBe('2 年前')
  })

  it('无法解析时原样返回', () => {
    expect(formatRelativeTime('not-a-date', now)).toBe('not-a-date')
    expect(formatRelativeTime('', now)).toBe('')
  })
})

describe('sanitizeRemoteUrl', () => {
  it('user:pass@ 与 user@ 都脱敏', () => {
    expect(sanitizeRemoteUrl('https://user:token@example.com/a.git')).toBe('https://***@example.com/a.git')
    expect(sanitizeRemoteUrl('https://user@example.com/a.git')).toBe('https://***@example.com/a.git')
    expect(sanitizeRemoteUrl('ssh://git@example.com/a.git')).toBe('ssh://***@example.com/a.git')
    expect(sanitizeRemoteUrl('https://example.com/a.git')).toBe('https://example.com/a.git')
    expect(sanitizeRemoteUrl('')).toBe('')
  })
})

describe('isValidBranchName', () => {
  it('接受合法分支名', () => {
    for (const name of ['main', 'feature/x', 'release-1.2', 'a_b.c', 'origin/main']) {
      expect(isValidBranchName(name)).toBe(true)
    }
  })

  it('拒绝 git check-ref-format 明令禁止的形态', () => {
    for (const name of ['', 'a..b', 'a b', 'a~1', 'a^b', 'a:b', 'a?b', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'a.', '.a', 'a.lock', 'a@{1', '@', '-x', '-']) {
      expect(isValidBranchName(name)).toBe(false)
    }
    expect(isValidBranchName('x'.repeat(201))).toBe(false)
  })
})

describe('isValidStashRef', () => {
  it('只接受 stash@{n}', () => {
    expect(isValidStashRef('stash@{0}')).toBe(true)
    expect(isValidStashRef('stash@{12}')).toBe(true)
    expect(isValidStashRef('stash@{}')).toBe(false)
    expect(isValidStashRef('stash@{0')).toBe(false)
    expect(isValidStashRef('refs/stash')).toBe(false)
    expect(isValidStashRef('')).toBe(false)
  })
})

// pull / push 禁用原因：侧边栏变更工具栏与中央 Git 管理器顶部状态条共用（0.0.376 入口上移后不再各写一份）。
describe('gitSyncDisabledReason', () => {
  const ready = {
    hasRemote: true,
    remoteStatusAvailable: true,
  }

  it('远端就绪且无占用：可点', () => {
    expect(gitSyncDisabledReason(ready)).toBe('')
    expect(gitSyncDisabledReason({})).toBe('仓库未配置远端')
  })

  it('按优先级给出第一处不满足的原因', () => {
    expect(gitSyncDisabledReason({ ...ready, operation: 'commit' })).toBe('Git 操作进行中')
    expect(gitSyncDisabledReason({ ...ready, operation: 'fetch' })).toBe('Git 操作进行中')
    expect(gitSyncDisabledReason({ ...ready, loading: true })).toBe('正在读取 Git 状态')
    expect(gitSyncDisabledReason({ ...ready, error: 'boom' })).toBe('Git 状态不可用')
    expect(gitSyncDisabledReason({ ...ready, detachedHead: true })).toBe('detached HEAD，请先切换分支')
    expect(gitSyncDisabledReason({ remoteStatusAvailable: true })).toBe('仓库未配置远端')
  })

  it('远端状态未确认：优先展示真实失败原因', () => {
    expect(gitSyncDisabledReason({ ...ready, remoteStatusAvailable: false, remoteStatusError: 'fetch 失败' }))
      .toBe('fetch 失败')
    expect(gitSyncDisabledReason({ ...ready, remoteStatusAvailable: false })).toBe('请刷新以确认远端状态')
  })
})

describe('gitPullDisabledReason', () => {
  const ready = {
    hasRemote: true,
    remoteStatusAvailable: true,
    upstream: 'origin/main',
    behindCount: 2,
  }

  it('有 upstream 且落后：可点', () => {
    expect(gitPullDisabledReason(ready)).toBe('')
  })

  it('无 upstream / 无落后提交时禁用', () => {
    expect(gitPullDisabledReason({ ...ready, upstream: undefined })).toBe('当前分支未配置 upstream')
    expect(gitPullDisabledReason({ ...ready, behindCount: 0 })).toBe('没有可拉取的更新')
    expect(gitPullDisabledReason({ ...ready, behindCount: undefined })).toBe('没有可拉取的更新')
  })

  it('共用原因优先于 pull 专属原因', () => {
    expect(gitPullDisabledReason({ ...ready, operation: 'push', behindCount: 0 })).toBe('Git 操作进行中')
  })
})

describe('gitPushDisabledReason', () => {
  const ready = {
    hasRemote: true,
    remoteStatusAvailable: true,
    hasHead: true,
    hasCommitsToPush: true,
  }

  it('有 HEAD 且确认可推送：可点', () => {
    expect(gitPushDisabledReason(ready)).toBe('')
  })

  it('空仓库 / 无提交可推 / 状态未确认时禁用', () => {
    expect(gitPushDisabledReason({ ...ready, hasHead: false })).toBe('没有可推送的提交')
    expect(gitPushDisabledReason({ ...ready, hasCommitsToPush: false })).toBe('没有可推送的提交')
    expect(gitPushDisabledReason({ ...ready, hasCommitsToPush: undefined })).toBe('无法确认可推送状态')
  })

  it('共用原因优先于 push 专属原因', () => {
    expect(gitPushDisabledReason({ ...ready, operation: 'pull', hasCommitsToPush: false })).toBe('Git 操作进行中')
  })
})

describe('buildGitTree / collectDirPaths（变更视图与分支对比视图共用）', () => {
  const file = (path: string): GitChangedFile => ({ path, changeType: 'MODIFIED', insertions: 1, deletions: 0 })

  it('空清单返回 []', () => {
    expect(buildGitTree([])).toEqual([])
    expect(buildGitTree([{ path: '', changeType: 'MODIFIED', insertions: 0, deletions: 0 }])).toEqual([])
  })

  it('目录在前、文件在后，各自按名称排序', () => {
    const tree = buildGitTree([file('b.txt'), file('a.txt'), file('src/x.ts')])
    expect(tree.map((n) => `${n.kind}:${n.name}`)).toEqual(['dir:src', 'file:a.txt', 'file:b.txt'])
  })

  it('嵌套目录按层级展开，非单链不压缩', () => {
    const tree = buildGitTree([file('src/components/git/A.vue'), file('src/utils/b.ts')])
    const src = tree[0]
    expect(src.kind).toBe('dir')
    if (src.kind !== 'dir') return
    expect(src.path).toBe('src')
    expect(src.children.map((c) => c.name)).toEqual(['components/git', 'utils'])
  })

  it('单链目录压缩为 a/b/c 包名样式', () => {
    const tree = buildGitTree([file('a/b/c/only.ts')])
    expect(tree).toHaveLength(1)
    const node = tree[0]
    expect(node.kind).toBe('dir')
    if (node.kind !== 'dir') return
    expect(node.name).toBe('a/b/c')
    expect(node.path).toBe('a/b/c')
    expect(node.children).toHaveLength(1)
    expect(node.children[0].kind).toBe('file')
  })

  it('rename 行按新路径建树，旧路径只作为 file.oldPath 展示', () => {
    const renamed: GitChangedFile = { path: 'src/new.ts', oldPath: 'src/old.ts', changeType: 'RENAMED', insertions: 2, deletions: 1 }
    const tree = buildGitTree([renamed])
    const dir = tree[0]
    expect(dir.kind).toBe('dir')
    if (dir.kind !== 'dir') return
    expect(dir.name).toBe('src')
    const leaf = dir.children[0]
    expect(leaf.kind).toBe('file')
    if (leaf.kind !== 'file') return
    expect(leaf.path).toBe('src/new.ts')
    expect(leaf.file.oldPath).toBe('src/old.ts')
  })

  it('collectDirPaths 收集可折叠目录节点', () => {
    const tree = buildGitTree([file('a/b/c/x.ts'), file('d/y.ts')])
    const out = new Set<string>()
    collectDirPaths(tree, out)
    expect(out.has('a/b/c')).toBe(true)
    expect(out.has('d')).toBe(true)
  })
})
