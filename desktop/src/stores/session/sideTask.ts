import { ref } from 'vue'
import { api } from '../../api'
import type { TaskPhase, SideTaskItem } from './types'

/** 边路任务（Side Task）缓存与操作：按父会话分组的列表、未读、pending 计数。 */
export function createSideTaskModule(ctx: {
  viewingSideTaskId: { value: number | null }
}) {
  const { viewingSideTaskId } = ctx

  // Side task list cache keyed by parentSessionId
  const sideTaskCache = ref<Map<string, SideTaskItem[]>>(new Map())
  /** 本地改过智能体的次数。列表刷新若在这次修改之前发出，响应不得把旧绑定盖回来。 */
  const agentRevision = new Map<number, number>()

  function setSideTasks(parentSessionId: string, tasks: SideTaskItem[]) {
    // unread / pending 以服务端为准（服务端 DB 是未读权威；本地已读在 markSideTaskRead API 成功后清除）
    sideTaskCache.value.set(String(parentSessionId), tasks)
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  async function refreshSideTasks(parentSessionId: string) {
    const revisionAtRequest = new Map(agentRevision)
    try {
      // recursive=1：主会话口径平铺全部后代边路任务（含深层）；parentSessionId 用于区分直接子级与深层后代
      const { data } = await api.get(`/sessions/${parentSessionId}/side-tasks`, { params: { recursive: 1 } })
      const prevById = new Map(
        (sideTaskCache.value.get(String(parentSessionId)) ?? []).map(t => [t.id, t]),
      )
      const items: SideTaskItem[] = Array.isArray(data)
        ? data.map((st: any) => {
            const prev = prevById.get(st.id)
            const localChanged = (agentRevision.get(st.id) ?? 0) !== (revisionAtRequest.get(st.id) ?? 0)
            // 列表只带 agentId。名称在补拉或切换时写入；刷新时同一 id 保留已有名称，换了人则丢掉旧名。
            // 请求发出后本地又切过的，以本地为准。
            const agentId = localChanged
              ? prev?.agentId
              : (st.agentId != null && st.agentId !== '' ? String(st.agentId) : prev?.agentId)
            const agentName = localChanged
              ? prev?.agentName
              : (prev && prev.agentId === agentId ? prev.agentName : undefined)
            return {
              id: st.id,
              title: st.title || '任务',
              agentId,
              agentName,
              modelId: st.modelId,
              parentSessionId: st.parentSessionId,
              permissionLevel: st.permissionLevel,
              phase: (st.phase || 'IDLE') as TaskPhase,
              createdAt: st.createdAt,
              updatedAt: st.updatedAt,
              startedAt: st.startedAt,
              unread: st.unread,
              pendingApprovalCount: st.pendingApprovalCount,
              pendingQuestionCount: st.pendingQuestionCount,
            }
          })
        : []
      setSideTasks(parentSessionId, items)
    } catch {
      // 保留现有缓存，等待下次会话切换或列表刷新同步
    }
  }

  function addSideTask(parentSessionId: string, task: SideTaskItem) {
    const key = String(parentSessionId)
    const list = sideTaskCache.value.get(key) ?? []
    const existing = list.find(t => t.id === task.id)
    // 搜索跳转等只带标题的补写不能清掉已经记下的智能体。
    const merged: SideTaskItem = existing
      ? {
          ...existing,
          ...task,
          agentId: task.agentId ?? existing.agentId,
          agentName: task.agentName ?? existing.agentName,
        }
      : task
    const filtered = list.filter(t => t.id !== task.id)
    sideTaskCache.value.set(key, [merged, ...filtered])
    sideTaskCache.value = new Map(sideTaskCache.value)
  }

  function updateSideTaskPhase(sideSessionId: number, phase: TaskPhase, startedAt?: string) {
    for (const [, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.phase = phase
        if (startedAt) item.startedAt = startedAt
        sideTaskCache.value = new Map(sideTaskCache.value)
        break
      }
    }
  }

  function updateSideTaskUnread(sideSessionId: number, unread: boolean): string | null {
    for (const [parentSessionId, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        if (unread && viewingSideTaskId.value === sideSessionId) {
          // 用户正打开着该边路任务 Tab：不计未读，并同步清除后端未读
          void markSideTaskRead(sideSessionId)
        } else {
          item.unread = unread
        }
        sideTaskCache.value = new Map(sideTaskCache.value)
        return parentSessionId
      }
    }
    return null
  }

  /** 按边路任务独立标记已读：仅在实际打开该边路任务 Tab 时调用。
   *  先同步后端已读，成功后再清除本地未读，避免后端 read 失败/竞态导致圆点看似清除、刷新后又复活。 */
  async function markSideTaskRead(sideSessionId: number) {
    try {
      await api.put(`/sessions/${sideSessionId}/read`)
    } catch {
      // 失败保留本地未读，下次打开 Tab 时重试
      return
    }
    for (const [, list] of sideTaskCache.value) {
      const idx = list.findIndex(t => t.id === sideSessionId)
      if (idx === -1) continue
      if (list[idx].unread) {
        list[idx].unread = false
        sideTaskCache.value = new Map(sideTaskCache.value)
      }
      break
    }
  }

  /** 只改这一条边路任务的智能体，不碰主会话和其他边路任务。 */
  function updateSideTaskAgent(sideSessionId: number, agentId: string, agentName?: string) {
    for (const [, list] of sideTaskCache.value) {
      const item = list.find(t => t.id === sideSessionId)
      if (!item) continue
      const changed = item.agentId !== agentId
      item.agentId = agentId
      if (agentName) item.agentName = agentName
      else if (changed) item.agentName = undefined
      if (changed) agentRevision.set(sideSessionId, (agentRevision.get(sideSessionId) ?? 0) + 1)
      sideTaskCache.value = new Map(sideTaskCache.value)
      break
    }
  }

  function updateSideTaskTitle(parentSessionId: string, sideSessionId: number, title: string, modelId?: number) {
    const list = sideTaskCache.value.get(String(parentSessionId))
    if (list) {
      const item = list.find(t => t.id === sideSessionId)
      if (item) {
        item.title = title
        if (modelId != null) item.modelId = modelId
        sideTaskCache.value = new Map(sideTaskCache.value)
      }
    }
  }

  /** 把边路任务 VO 上的待审批/待回答计数与客户端实时状态同步（左侧橙点与聚焦排序同源消费该字段）。
   *  仅当 sessionId 命中某个缓存的边路任务时生效，主会话/子代理调用为 no-op。 */
  function syncSideTaskPendingCount(
    sessionId: string,
    field: 'pendingApprovalCount' | 'pendingQuestionCount',
    count: number
  ) {
    const sid = String(sessionId)
    for (const [, list] of sideTaskCache.value) {
      const item = list.find(t => String(t.id) === sid)
      if (item) {
        if (item[field] !== count) {
          item[field] = count
          sideTaskCache.value = new Map(sideTaskCache.value)
        }
        return
      }
    }
  }

  /** 任务树聚合计数归零是权威信号：树内已无待审批/待回答时，边路缓存里残留的 VO 计数一并清零。
   *  覆盖提问/审批在断线期间于飞书等入口被处理、终态事件全部丢失导致的计数残留。 */
  function reconcileSideTaskPendingCounts(parentSessionId: string, approvalCount?: number, questionCount?: number) {
    if ((approvalCount == null || approvalCount > 0) && (questionCount == null || questionCount > 0)) return
    const list = sideTaskCache.value.get(String(parentSessionId))
    if (!list) return
    let changed = false
    for (const item of list) {
      if (approvalCount === 0 && item.pendingApprovalCount) {
        item.pendingApprovalCount = 0
        changed = true
      }
      if (questionCount === 0 && item.pendingQuestionCount) {
        item.pendingQuestionCount = 0
        changed = true
      }
    }
    if (changed) sideTaskCache.value = new Map(sideTaskCache.value)
  }

  function removeSideTask(parentSessionId: string, sideSessionId: number) {
    const key = String(parentSessionId)
    const list = sideTaskCache.value.get(key)
    if (list) {
      sideTaskCache.value.set(key, list.filter(t => t.id !== sideSessionId))
      sideTaskCache.value = new Map(sideTaskCache.value)
    }
  }

  function getSideTasks(parentSessionId: string): SideTaskItem[] {
    return sideTaskCache.value.get(String(parentSessionId)) ?? []
  }

  /** 按边路任务 id 反查其所属缓存键（根主会话 id 字符串）：递归平铺口径下事件只带直接父 id 时用。 */
  function findSideTaskRootKey(sideSessionId: number): string | null {
    for (const [parentSessionId, list] of sideTaskCache.value) {
      if (list.some(t => t.id === sideSessionId)) return parentSessionId
    }
    return null
  }

  function reset() {
    sideTaskCache.value = new Map()
    agentRevision.clear()
  }

  return {
    sideTaskCache,
    setSideTasks,
    refreshSideTasks,
    addSideTask,
    updateSideTaskPhase,
    updateSideTaskUnread,
    markSideTaskRead,
    updateSideTaskAgent,
    updateSideTaskTitle,
    syncSideTaskPendingCount,
    reconcileSideTaskPendingCounts,
    removeSideTask,
    getSideTasks,
    findSideTaskRootKey,
    reset,
  }
}
