import { normalizeMessageRole, type ChatMessage } from '../types/chat'
import { ACTIVE_PHASES, type TaskPhase } from '../stores/session/types'

/**
 * 边路任务 / 子代理面板在 fetchMessages 覆盖缓存前，是否需要保留本地流式气泡。
 *
 * 背景：刷新或重连后先 subscribe 再拉历史，服务端重放的「执行中」工具先于 REST
 * 历史写入缓存；不保留就会被整表覆盖，工具调用从界面消失。
 *
 * 但终态下 REST 是权威：本地可能还挂着被部署重启顶掉的旧执行气泡（running 工具
 * 永远等不到结果）。保留会把旧气泡追加到最终回复之后，轮次渲染取最后一条 assistant
 * 当 finalReply，真正的最终回复反被折叠进步骤区（部署后「执行到一半没有结果」回归）。
 *
 * phase 未知（尚未拉到会话状态）时维持旧行为，避免误伤刚建立的真实流式。
 */
export function shouldPreserveLiveStreamOnFetch(options: {
  phase: TaskPhase | null | undefined
  streaming: boolean
  lastMessage?: ChatMessage | null
}): boolean {
  const { phase, streaming, lastMessage } = options
  if (phase && !ACTIVE_PHASES.has(phase)) return false
  if (streaming) return true
  if (lastMessage && normalizeMessageRole(lastMessage.role) === 'assistant') {
    return lastMessage.toolCalls?.some(tc => tc.status === 'pending' || tc.status === 'running') ?? false
  }
  return false
}
