import { describe, expect, it } from 'vitest'
import {
  addSkillGrants,
  reconcileAgentSelection,
  removeSkillGrants,
  type SkillGrant,
} from './roleSkillGrantEdit'

const rows: SkillGrant[] = [
  { skillName: 'page-replay-cli', agentId: 12 },
  { skillName: 'page-replay-cli', agentId: 34 },
  { skillName: 'git', agentId: 0 },
]

describe('角色技能范围多选', () => {
  it('新勾上全部 Agent 时清掉已选的具体 Agent', () => {
    expect(reconcileAgentSelection([12, 34], [12, 34, 0])).toEqual([0])
  })

  it('已是全部 Agent 时再勾具体 Agent，丢掉全部', () => {
    expect(reconcileAgentSelection([0], [0, 12])).toEqual([12])
    expect(reconcileAgentSelection([0], [0, 12, 34])).toEqual([12, 34])
  })

  it('只选具体 Agent 时保持勾选顺序并去重', () => {
    expect(reconcileAgentSelection([], [34, 12, 34])).toEqual([34, 12])
    expect(reconcileAgentSelection([12], [12])).toEqual([12])
  })

  it('一次添加展开成多行，已有的跳过', () => {
    const result = addSkillGrants(rows, 'page-replay-cli', [12, 56, 56])
    expect(result.blocked).toBe(false)
    expect(result.added).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.grants).toEqual([
      ...rows,
      { skillName: 'page-replay-cli', agentId: 56 },
    ])
    expect(rows).toHaveLength(3)
  })

  it('已有具体 Agent 时不能再加全部 Agent', () => {
    const result = addSkillGrants(rows, 'page-replay-cli', [0])
    expect(result.blocked).toBe(true)
    expect(result.added).toBe(0)
    expect(result.grants).toEqual(rows)
  })

  it('已是全部 Agent 时不能再加具体 Agent', () => {
    const result = addSkillGrants(rows, 'git', [12])
    expect(result.blocked).toBe(true)
    expect(result.grants).toEqual(rows)
  })

  it('同一批里同时有全部和具体 Agent 时整批不加', () => {
    const result = addSkillGrants([], 'git', [0, 12])
    expect(result.blocked).toBe(true)
    expect(result.grants).toEqual([])
  })

  it('勾选多行按技能和 Agent 一起摘掉', () => {
    const next = removeSkillGrants(rows, [
      { skillName: 'page-replay-cli', agentId: 12 },
      { skillName: 'git', agentId: 0 },
    ])
    expect(next).toEqual([{ skillName: 'page-replay-cli', agentId: 34 }])
  })
})
