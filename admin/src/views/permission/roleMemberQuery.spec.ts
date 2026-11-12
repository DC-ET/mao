import { describe, expect, it } from 'vitest'
import { isRoleMember, roleMemberListParams } from './roleMemberQuery'

describe('角色成员弹窗列表', () => {
  it('数字与字符串角色 id 都算已加入', () => {
    expect(isRoleMember(6, [2, 6])).toBe(true)
    expect(isRoleMember(6, ['6'])).toBe(true)
    expect(isRoleMember('6', [6])).toBe(true)
    expect(isRoleMember(6, [2, 3])).toBe(false)
    expect(isRoleMember(6, null)).toBe(false)
    expect(isRoleMember(null, [6])).toBe(false)
  })

  it('当前成员模式带上 roleId', () => {
    expect(roleMemberListParams({
      page: 1,
      size: 10,
      keyword: '  张  ',
      mode: 'members',
      roleId: 6,
    })).toEqual({ page: 1, size: 10, keyword: '张', roleId: 6 })
  })

  it('全部用户模式不带 roleId，空关键词不传', () => {
    expect(roleMemberListParams({
      page: 2,
      size: 20,
      keyword: '   ',
      mode: 'all',
      roleId: 6,
    })).toEqual({ page: 2, size: 20 })
  })
})
