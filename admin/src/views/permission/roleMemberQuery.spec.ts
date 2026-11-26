import { describe, expect, it } from 'vitest'
import { isRoleMember, roleMemberListParams, togglePageSelection } from './roleMemberQuery'

describe('角色成员弹窗列表', () => {
  it('数字与字符串角色 id 都算已加入', () => {
    expect(isRoleMember(6, [2, 6])).toBe(true)
    expect(isRoleMember(6, ['6'])).toBe(true)
    expect(isRoleMember('6', [6])).toBe(true)
    expect(isRoleMember(6, [2, 3])).toBe(false)
    expect(isRoleMember(6, null)).toBe(false)
    expect(isRoleMember(null, [6])).toBe(false)
  })

  it('成员栏带上 roleId', () => {
    expect(roleMemberListParams({
      page: 1,
      size: 10,
      keyword: '  张  ',
      mode: 'members',
      roleId: 6,
    })).toEqual({ page: 1, size: 10, keyword: '张', roleId: 6 })
  })

  it('候选栏带 excludeRoleId，空关键词不传', () => {
    expect(roleMemberListParams({
      page: 2,
      size: 20,
      keyword: '   ',
      mode: 'candidates',
      roleId: 6,
    })).toEqual({ page: 2, size: 20, excludeRoleId: 6 })
  })

  it('本页全选只增删本页行，保留其他页已勾的人', () => {
    const a = { id: 1 }
    const b = { id: 2 }
    const c = { id: 3 }
    const start = new Map([[a.id, a]])
    const added = togglePageSelection(start, [b, c], true)
    expect([...added.keys()]).toEqual([1, 2, 3])
    expect([...start.keys()]).toEqual([1])
    const removed = togglePageSelection(added, [b, c], false)
    expect([...removed.keys()]).toEqual([1])
  })
})
