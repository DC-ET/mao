import { ref, computed, watch, type Ref } from 'vue'
import { api } from '../api'
import { mapMessagesWithFileChanges, mapCompactionEvents } from '../utils/chatMessage'
import type { ChatMessage, CompactionEvent, FileChange } from '../types/chat'

/**
 * Fork 预览（边路任务发起前预演）。
 *
 * 选中「Fork 来源会话 / Fork 主会话」时，边路占位 Tab 的消息区展示真实 fork 后会得到的
 * 历史消息，让用户在发出首条消息前就确认「这条支线会带着哪些上下文」。
 *
 * 预览刻意不写 sessionStore 消息缓存：占位 Tab 的真实 id 尚未分配，写进去会在会话转正、
 * tab 复用、卸载清理等多条路径上和后端 fork 回来的消息抢镜/双份。预览只活在本地 ref，
 * `fetchMessages` 在 fork 落库后按真实会话 id 重新拉取，天然覆盖。
 *
 * 请求口径与真实 fork 完全同源：`/sessions/:id/fork-preview` 用与 `/messages` 相同的
 * 轮次分页（roundLimit / hasMore / nextBeforeMessageId），只把上界换成切点。
 */
export function useForkPreview(options: {
  /** 来源会话 id（边路发起时为该边路会话，缺省主会话） */
  sourceSessionId: Ref<string | null>
  /** 当前继承方式 */
  contextMode: Ref<'none' | 'summary' | 'fork'>
  /** 按轮分叉切点，null = 全量分叉 */
  forkFromMessageId: Ref<number | null>
  /** 占位态的预览只在没有真实会话时才有意义 */
  hasRealSession: Ref<boolean>
}) {
  const messages = ref<ChatMessage[]>([])
  const compactionEvents = ref<CompactionEvent[]>([])
  const fileChanges = ref<FileChange[]>([])
  const hasMore = ref(false)
  const loading = ref(false)
  const loadingOlder = ref(false)
  const nextBeforeMessageId = ref<number | null>(null)
  /** 请求代次：切点 / 来源 / 模式切换会让在途响应过期，晚到者不得覆盖最新状态 */
  let generation = 0

  const enabled = computed(() =>
    !options.hasRealSession.value
    && options.contextMode.value === 'fork'
    && (options.sourceSessionId.value ?? '') !== ''
  )

  async function load() {
    const sid = options.sourceSessionId.value
    if (!sid || !enabled.value) return
    const gen = ++generation
    loading.value = true
    try {
      const { data } = await api.get(`/sessions/${sid}/fork-preview`, {
        params: {
          roundLimit: 5,
          ...(options.forkFromMessageId.value != null ? { forkFromMessageId: options.forkFromMessageId.value } : {}),
        },
      })
      // 在途期间切点/来源已变：丢弃这次响应，否则旧切点的历史会闪现在新切点下
      if (gen !== generation) return
      const raw: Array<Record<string, unknown>> = data?.messages || []
      const { messages: mapped, allChanges } = mapMessagesWithFileChanges(raw)
      messages.value = mapped
      fileChanges.value = allChanges
      compactionEvents.value = Array.isArray(data?.compactionEvents)
        ? mapCompactionEvents(data.compactionEvents)
        : []
      hasMore.value = Boolean(data?.hasMore)
      const cursor = Number(data?.nextBeforeMessageId)
      nextBeforeMessageId.value = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null
    } catch {
      // 预览失败不影响发起：发送时后端仍按同一口径复制；失败只表现为消息区回到空态
      if (gen !== generation) return
      messages.value = []
      compactionEvents.value = []
      fileChanges.value = []
      hasMore.value = false
      nextBeforeMessageId.value = null
    } finally {
      if (gen === generation) loading.value = false
    }
  }

  async function loadOlder(): Promise<boolean> {
    const sid = options.sourceSessionId.value
    if (!sid || loadingOlder.value || !hasMore.value || !nextBeforeMessageId.value) return false
    const gen = generation
    loadingOlder.value = true
    try {
      const { data } = await api.get(`/sessions/${sid}/fork-preview`, {
        params: {
          roundLimit: 5,
          beforeMessageId: nextBeforeMessageId.value,
          ...(options.forkFromMessageId.value != null ? { forkFromMessageId: options.forkFromMessageId.value } : {}),
        },
      })
      if (gen !== generation) return false
      const raw: Array<Record<string, unknown>> = data?.messages || []
      if (raw.length === 0) return false
      const { messages: mapped, allChanges } = mapMessagesWithFileChanges(raw)
      messages.value = [...mapped, ...messages.value]
      fileChanges.value = [...allChanges, ...fileChanges.value]
      hasMore.value = Boolean(data?.hasMore)
      const cursor = Number(data?.nextBeforeMessageId)
      nextBeforeMessageId.value = Number.isSafeInteger(cursor) && cursor > 0 ? cursor : null
      return true
    } catch {
      return false
    } finally {
      if (gen === generation) loadingOlder.value = false
    }
  }

  function clear() {
    // 让在途响应失效：切走 fork / 会话转正时旧预览不得再出现
    generation++
    messages.value = []
    compactionEvents.value = []
    fileChanges.value = []
    hasMore.value = false
    loading.value = false
    loadingOlder.value = false
    nextBeforeMessageId.value = null
  }

  // immediate：占位 Tab 挂载时常常已经带着 fork 预置（fork 图标入口直接新建 Tab），
  // 非 immediate 的 watch 只在值变化时触发，那种情况下预览永远不出现。
  watch(enabled, (on) => {
    if (on) void load()
    else clear()
  }, { immediate: true })

  watch(() => options.forkFromMessageId.value, (cut, prev) => {
    if (!enabled.value) return
    if (cut === prev) return
    void load()
  })

  return {
    messages,
    compactionEvents,
    fileChanges,
    hasMore,
    loading,
    loadingOlder,
    load,
    loadOlder,
    clear,
  }
}

export type ForkPreview = ReturnType<typeof useForkPreview>
