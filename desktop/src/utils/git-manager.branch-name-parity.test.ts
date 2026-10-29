import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { isValidBranchName } from './git-manager'

/**
 * 跨端对拍：分支名校验规则存在三份实现——前端预检（本目录）、Electron 只读侧
 * （electron/gitStatus.cjs）、后端只读侧（backend-ts workspace-git.service.ts，
 * 由其后端 spec 覆盖）。三份无法共享代码，规则一旦单侧漂移，前端会把两端都
 * 接受的分支名静默挡成「分支不存在」（用户可见）。这里用同一组名字把前端与
 * Electron 两份逐例对拍锁死；两边注释中的字符类/结构规则必须保持同步。
 */
const requireCjs = createRequire(import.meta.url)
const electronGitStatus = requireCjs('../../electron/gitStatus.cjs') as {
  isValidBranchName: (name: string) => boolean
}

const ACCEPTED = [
  'main',
  'feature/x',
  'origin/main',
  'release-1.0',
  'a_b/c-d',
  'v1.2.3',
  'A.B-c_d',
  '_draft',
  'a'.repeat(200),
]

const REJECTED = [
  '',
  '-',
  '-x',
  '..',
  'a..b',
  '/a',
  'a/',
  'a//b',
  'a.',
  '.a',
  'a.lock',
  '@',
  'a@{1}',
  'a b',
  'a~1',
  'a^b',
  'a:b',
  'a?b',
  'a*b',
  'a[b',
  'a\\b',
  'feat+1',
  'feat#1',
  '中文分支',
  'a'.repeat(201),
]

describe('isValidBranchName 与 Electron 只读侧规则一致（跨端对拍）', () => {
  it('接受集：前端接受且 Electron 接受', () => {
    expect(ACCEPTED.length).toBeGreaterThan(0)
    for (const name of ACCEPTED) {
      expect({ name, front: isValidBranchName(name) }).toEqual({ name, front: true })
      expect({ name, electron: electronGitStatus.isValidBranchName(name) }).toEqual({ name, electron: true })
    }
  })

  it('拒绝集：前端拒绝且 Electron 拒绝', () => {
    expect(REJECTED.length).toBeGreaterThan(0)
    for (const name of REJECTED) {
      expect({ name, front: isValidBranchName(name) }).toEqual({ name, front: false })
      expect({ name, electron: electronGitStatus.isValidBranchName(name) }).toEqual({ name, electron: false })
    }
  })
})
