export type RoleMemberListMode = 'members' | 'all'

/** 角色 id 与用户 roleIds 对齐。两侧通常都是数字；字符串形式也认，避免已加入被判成未加入。 */
export function isRoleMember(roleId: unknown, roleIds: unknown): boolean {
  if (roleId == null || roleId === '' || !Array.isArray(roleIds)) return false
  const target = String(roleId)
  return roleIds.some((id) => id != null && id !== '' && String(id) === target)
}

/** 成员弹窗列表参数。默认只查当前角色的成员。 */
export function roleMemberListParams(input: {
  page: number
  size: number
  keyword: string
  mode: RoleMemberListMode
  roleId: unknown
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    page: input.page,
    size: input.size,
  }
  const keyword = input.keyword.trim()
  if (keyword) params.keyword = keyword
  if (input.mode === 'members' && input.roleId != null && input.roleId !== '') {
    params.roleId = input.roleId
  }
  return params
}
