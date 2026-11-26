/** members=该角色的成员（右栏）；candidates=尚未加入该角色的用户（左栏）。 */
export type RoleMemberListMode = 'members' | 'candidates'

export interface RoleMemberUser {
  id: number
  username: string
  displayName?: string | null
  email?: string | null
  status?: number | null
}

/** 角色 id 与用户 roleIds 对齐。两侧通常都是数字；字符串形式也认，避免已加入被判成未加入。 */
export function isRoleMember(roleId: unknown, roleIds: unknown): boolean {
  if (roleId == null || roleId === '' || !Array.isArray(roleIds)) return false
  const target = String(roleId)
  return roleIds.some((id) => id != null && id !== '' && String(id) === target)
}

/** 成员弹窗两栏的列表参数：右栏按 roleId 只查成员，左栏按 excludeRoleId 排除成员，分页总数各自准确。 */
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
  if (input.roleId != null && input.roleId !== '') {
    params[input.mode === 'members' ? 'roleId' : 'excludeRoleId'] = input.roleId
  }
  return params
}

/** 跨页/跨搜索保留勾选：本页全选切换时只增删本页行，不动其他页已勾的人。 */
export function togglePageSelection<T extends { id: number }>(
  selected: Map<number, T>,
  pageRows: T[],
  checked: boolean,
): Map<number, T> {
  const next = new Map(selected)
  for (const row of pageRows) {
    if (checked) next.set(row.id, row)
    else next.delete(row.id)
  }
  return next
}
