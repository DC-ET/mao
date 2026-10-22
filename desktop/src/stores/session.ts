import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createSessionListModule } from './session/list'
import { createMessageRuntimeModule } from './session/messages'
import { createSideTaskModule } from './session/sideTask'
import { createSubagentModule } from './session/subagent'
import { createTraceModule } from './session/trace'

export * from './session/types'

export const useSessionStore = defineStore('session', () => {
  /** 用户当前正在查看的边路任务 Tab（sideSessionId），未查看时为 null。由 useCenterTabs 维护。 */
  const viewingSideTaskId = ref<number | null>(null)

  function setViewingSideTask(sideSessionId: number | null) {
    viewingSideTaskId.value = sideSessionId
  }

  const sideTask = createSideTaskModule({ viewingSideTaskId })
  const subagent = createSubagentModule()
  const trace = createTraceModule()

  const list = createSessionListModule({
    sessionPendingApprovals: () => messageRuntime.sessionPendingApprovals,
    sessionPendingQuestions: () => messageRuntime.sessionPendingQuestions,
    sessionContextWindow: () => messageRuntime.sessionContextWindow,
    ctxSessionPhases: () => messageRuntime.sessionPhases,
    viewingSideTaskId,
    purgeSessionRuntime: (sid) => {
      messageRuntime.purgeSessionRuntime(sid)
      // 记录详情抽屉的正文缓存（工具参数 / 结果）随会话删除一起丢：抽屉正文是用户
      // 期望「删除会话即消失」的敏感数据，不能留到登出或整页刷新才清。
      trace.clearTraceRecords(sid)
    },
    reconcileSideTaskPendingCounts: sideTask.reconcileSideTaskPendingCounts,
    setCompacting: (sid, v) => messageRuntime.setCompacting(sid, v),
    clearLlmRetry: (sid) => messageRuntime.clearLlmRetry(sid),
    setLlmRetry: (sid, info) => messageRuntime.setLlmRetry(sid, info),
    setExecutionError: (sid, msg) => messageRuntime.setExecutionError(sid, msg),
  })

  const messageRuntime = createMessageRuntimeModule({
    getActiveSessionId: () => list.activeSessionId.value,
    syncSideTaskPendingCount: sideTask.syncSideTaskPendingCount,
  })

  function reset() {
    list.reset()
    messageRuntime.reset()
    sideTask.reset()
    subagent.reset()
    trace.reset()
    viewingSideTaskId.value = null
  }

  return {
    // list domain
    ...list,
    // message runtime domain
    ...messageRuntime,
    // sideTask domain
    ...sideTask,
    // subagent domain
    ...subagent,
    // run trace domain
    ...trace,
    // shared
    viewingSideTaskId,
    setViewingSideTask,
    reset,
  }
})
