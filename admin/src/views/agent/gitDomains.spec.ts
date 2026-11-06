import { describe, expect, it } from 'vitest'
import { gitDomainsEnabledOf, gitDomainsListOf, gitDomainsPayload } from './gitDomains'

describe('Git 凭据域表单映射（技术方案 2026-11-06 §3.6）', () => {
  it('回显：null/undefined 视为关闭；[] 与数组视为开启', () => {
    expect(gitDomainsEnabledOf(null)).toBe(false)
    expect(gitDomainsEnabledOf(undefined)).toBe(false)
    expect(gitDomainsEnabledOf([])).toBe(true)
    expect(gitDomainsEnabledOf(['git.acg.team'])).toBe(true)
  })

  it('回显：把 VO 数组复制为表单列表，null/undefined → 空列表', () => {
    expect(gitDomainsListOf(null)).toEqual([])
    expect(gitDomainsListOf(undefined)).toEqual([])
    expect(gitDomainsListOf([])).toEqual([])
    const source = ['git.acg.team']
    const copy = gitDomainsListOf(source)
    expect(copy).toEqual(source)
    expect(copy).not.toBe(source)
  })

  it('提交：关闭开关 → null（不限制，不因空列表误判为禁止）', () => {
    expect(gitDomainsPayload(false, [])).toBeNull()
    expect(gitDomainsPayload(false, ['git.acg.team'])).toBeNull()
  })

  it('提交：开启 + 空列表 → []（显式禁止注入）', () => {
    expect(gitDomainsPayload(true, [])).toEqual([])
    expect(gitDomainsPayload(true, ['   '])).toEqual([])
  })

  it('提交：去空白、去重后输出白名单', () => {
    expect(gitDomainsPayload(true, [' git.acg.team ', 'git.acg.team', 'git.other.com'])).toEqual([
      'git.acg.team',
      'git.other.com',
    ])
  })
})
