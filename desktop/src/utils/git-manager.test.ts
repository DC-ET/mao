import { describe, expect, it } from 'vitest'
import {
  formatRelativeTime,
  isValidBranchName,
  isValidStashRef,
  parseBranchLine,
  parseRefsDecorations,
  parseStashLine,
  sanitizeRemoteUrl,
} from './git-manager'

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
    for (const name of ['', 'a..b', 'a b', 'a~1', 'a^b', 'a:b', 'a?b', 'a[b', 'a\\b', '/a', 'a/', 'a//b', 'a.', '.a', 'a.lock', 'a@{1', '@']) {
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
