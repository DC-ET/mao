/** agentId = 0：该角色使用任何 Agent 都追加。与具体 Agent 互斥。 */
export const ALL_AGENTS_ID = 0

export interface SkillGrant {
  skillName: string
  agentId: number
}

export interface AddSkillGrantResult {
  grants: SkillGrant[]
  added: number
  skipped: number
  /** 同一技能不能同时是「全部 Agent」和某个具体 Agent。整批不加。 */
  blocked: boolean
}

function cleanAgentIds(ids: readonly number[]): number[] {
  const out: number[] = []
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0 || out.includes(id)) continue
    out.push(id)
  }
  return out
}

/**
 * 「全部 Agent」与具体 Agent 不能同时留在选择里。
 * 新勾上全部时清掉具体 Agent；已是全部时再勾具体 Agent，则丢掉全部。
 */
export function reconcileAgentSelection(previous: readonly number[], next: readonly number[]): number[] {
  const prev = cleanAgentIds(previous)
  const picked = cleanAgentIds(next)
  const hasAll = picked.includes(ALL_AGENTS_ID)
  const specifics = picked.filter((id) => id !== ALL_AGENTS_ID)
  if (!hasAll) return specifics
  if (specifics.length === 0) return [ALL_AGENTS_ID]
  if (!prev.includes(ALL_AGENTS_ID)) return [ALL_AGENTS_ID]
  return specifics
}

/** 把一次多选展开成多行。已有的 (技能, Agent) 跳过，其余追加。不改入参。 */
export function addSkillGrants(
  existing: readonly SkillGrant[],
  skillName: string,
  agentIds: readonly number[],
): AddSkillGrantResult {
  const name = skillName.trim()
  const ids = cleanAgentIds(agentIds)
  if (!name || ids.length === 0) {
    return { grants: [...existing], added: 0, skipped: 0, blocked: false }
  }
  const wantsAll = ids.includes(ALL_AGENTS_ID)
  const wantsSpecific = ids.some((id) => id !== ALL_AGENTS_ID)
  const sameSkill = existing.filter((grant) => grant.skillName === name)
  const hasAll = sameSkill.some((grant) => grant.agentId === ALL_AGENTS_ID)
  const hasSpecific = sameSkill.some((grant) => grant.agentId !== ALL_AGENTS_ID)
  if ((wantsAll && wantsSpecific) || (wantsAll && hasSpecific) || (wantsSpecific && hasAll)) {
    return { grants: [...existing], added: 0, skipped: 0, blocked: true }
  }
  const owned = new Set(sameSkill.map((grant) => grant.agentId))
  const fresh = ids.filter((id) => !owned.has(id))
  return {
    grants: [...existing, ...fresh.map((agentId) => ({ skillName: name, agentId }))],
    added: fresh.length,
    skipped: ids.length - fresh.length,
    blocked: false,
  }
}

export function grantKey(grant: SkillGrant): string {
  return `${grant.skillName}\0${grant.agentId}`
}

/** 按 (技能, Agent) 摘掉勾选的行。表格仍是一行一个 Agent。 */
export function removeSkillGrants(existing: readonly SkillGrant[], selected: readonly SkillGrant[]): SkillGrant[] {
  const keys = new Set(selected.map(grantKey))
  if (keys.size === 0) return [...existing]
  return existing.filter((grant) => !keys.has(grantKey(grant)))
}
