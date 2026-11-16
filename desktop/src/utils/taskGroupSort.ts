import type { Session } from '../stores/session'

/**
 * 组内排序（标准模式）：任务树活跃优先 → updatedAt（缺省 createdAt）DESC → id DESC。
 *
 * 「任务树活跃」= 主任务自身或边路任务处于活跃相位，或整树有待审批 / 待回答
 * （判定口径见 TaskIndexPanel.vue isTreeActive，与圆点 / 转圈同源）。
 *
 * 活跃集合由调用方一次性预计算后传入：判定依赖 store 实时表与边路缓存，
 * 收在纯函数外既保 comparator 内只做 Set 查询，也避免两套口径漂移。
 */
export function sortSessionsInGroup(
  sessions: readonly Session[],
  treeActiveIds: ReadonlySet<string>,
): Session[] {
  return [...sessions].sort((a, b) => {
    const activeA = treeActiveIds.has(String(a.id))
    const activeB = treeActiveIds.has(String(b.id))
    if (activeA !== activeB) return activeA ? -1 : 1
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
    if (tb !== ta) return tb - ta
    // updated_at 相同时按 id 倒序，避免批量更新导致按创建正序排列
    return Number(b.id) - Number(a.id)
  })
}
