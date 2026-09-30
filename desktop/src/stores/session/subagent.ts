import { ref } from 'vue'
import type { TaskPhase, SubagentItem } from './types'

/** 子代理（Subagent）缓存与操作：按父会话分组的列表、delegate 绑定。 */
export function createSubagentModule() {
  // Subagent list cache keyed by parentSessionId
  const subagentCache = ref<Map<string, SubagentItem[]>>(new Map())
  /** parent tool_call_id → child session id（并行 delegate 精确绑定） */
  const delegateToolCallBindings = ref<Map<string, number>>(new Map())

  function setSubagents(parentSessionId: string, tasks: SubagentItem[]) {
    subagentCache.value.set(String(parentSessionId), tasks)
    subagentCache.value = new Map(subagentCache.value)
  }

  function addSubagent(parentSessionId: string, task: SubagentItem) {
    const key = String(parentSessionId)
    const list = subagentCache.value.get(key) ?? []
    const filtered = list.filter(t => t.id !== task.id)
    subagentCache.value.set(key, [task, ...filtered])
    subagentCache.value = new Map(subagentCache.value)
  }

  function updateSubagentPhase(childSessionId: number, phase: TaskPhase) {
    for (const [, list] of subagentCache.value) {
      const item = list.find(t => t.id === childSessionId)
      if (item) {
        item.phase = phase
        subagentCache.value = new Map(subagentCache.value)
        break
      }
    }
  }

  /** 合并更新子代理元数据（补拉 /sessions/{id} 后写回缓存）。 */
  function updateSubagentMeta(childSessionId: number, meta: { title?: string; phase?: TaskPhase; modelId?: number }) {
    for (const [, list] of subagentCache.value) {
      const item = list.find(t => t.id === childSessionId)
      if (item) {
        if (meta.title) item.title = meta.title
        if (meta.phase) item.phase = meta.phase
        if (meta.modelId != null) item.modelId = meta.modelId
        subagentCache.value = new Map(subagentCache.value)
        break
      }
    }
  }

  function getSubagents(parentSessionId: string): SubagentItem[] {
    return subagentCache.value.get(String(parentSessionId)) ?? []
  }

  function findSubagentChildId(
    parentSessionId: string,
    opts?: { runningOnly?: boolean; agentType?: string; task?: string }
  ): number | null {
    const list = getSubagents(parentSessionId)
    let candidates = opts?.runningOnly
      ? list.filter(t => t.phase === 'RUNNING' || t.phase === 'WAITING_APPROVAL' || t.phase === 'CANCELLING')
      : list
    if (opts?.agentType) {
      const byType = candidates.filter(t => t.agentType === opts.agentType)
      if (byType.length > 0) candidates = byType
    }
    if (opts?.task != null && opts.task !== '') {
      const byTask = candidates.filter(t => t.taskDescription === opts.task)
      if (byTask.length === 1) return byTask[0].id
      if (byTask.length > 1) candidates = byTask
    }
    return candidates.length === 1 ? candidates[0].id : null
  }

  function bindDelegateToolCall(toolCallId: string, childSessionId: number) {
    if (!toolCallId || !(childSessionId > 0)) return
    delegateToolCallBindings.value.set(String(toolCallId), childSessionId)
    delegateToolCallBindings.value = new Map(delegateToolCallBindings.value)
  }

  function findSubagentByToolCallId(toolCallId: string | undefined | null): number | null {
    if (!toolCallId) return null
    const id = delegateToolCallBindings.value.get(String(toolCallId))
    return id != null && id > 0 ? id : null
  }

  function reset() {
    subagentCache.value = new Map()
    delegateToolCallBindings.value = new Map()
  }

  return {
    subagentCache,
    delegateToolCallBindings,
    setSubagents,
    addSubagent,
    updateSubagentPhase,
    updateSubagentMeta,
    getSubagents,
    findSubagentChildId,
    bindDelegateToolCall,
    findSubagentByToolCallId,
    reset,
  }
}
