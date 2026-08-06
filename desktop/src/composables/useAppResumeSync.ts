/**
 * 回前台恢复协调器（仅安卓 Capacitor 平台）。
 *
 * 触发：document visibilitychange 恢复（WebView 回前台）——不依赖 @capacitor/app，
 * 复用现有运行时注入模式。
 *
 * 流程（recovery 协议，见 docs/android-websocket-keepalive-design.md §5.3）：
 * 1. connect() 确保原生连接/服务（Service 在则复用连接）
 * 2. beginRecovery() → 原生进入 SYNC 模式并重放水位内事件（JS 侧 wsBridge 去重 + ACK）
 * 3. 对 restSyncSessionIds 会话执行 REST 权威快照校准（消息/活动/Todo/队列/phase 覆盖）
 * 4. completeRestSync(recoveryId, 成功会话) —— 失败的保留待下次
 * 5. completeRecovery(recoveryId) → 原生补放水位后事件 + 发 replayDone + compact
 *
 * pendingNavigate：通知点击冷启动/热启动跳转（MainActivity → 插件事件 → 这里路由跳转）。
 */
import { useRouter } from 'vue-router'
import { api } from '../api'
import { useSessionStore } from '../stores/session'
import { useStreamWS } from './useStreamWS'
import { getActiveBridge, setWsBridgeHandlers, shouldUseNativeBridge } from '../capacitor/wsBridge'
import { mapMessagesWithFileChanges } from '../utils/chatMessage'

let initialized = false
let recoveryInProgress = false

export function useAppResumeSync() {
  const router = useRouter()
  const sessionStore = useSessionStore()

  async function restCalibrate(sessionId: number): Promise<boolean> {
    const sidStr = String(sessionId)
    try {
      const [msgRes, todoRes, queueRes] = await Promise.all([
        api.get(`/sessions/${sessionId}/messages`, { params: { roundLimit: 5 } }),
        api.get(`/sessions/${sessionId}/todos`),
        api.get(`/sessions/${sessionId}/queue`)
      ])
      const raw: Array<Record<string, unknown>> = msgRes.data?.messages || []
      const { messages, allChanges } = mapMessagesWithFileChanges(raw)
      // 权威快照覆盖（先清缓存再填充，避免与旧流式增量叠加）
      sessionStore.setMessages(sidStr, messages)
      sessionStore.setFileChanges(sidStr, allChanges)
      sessionStore.setTodos(sidStr, todoRes.data || [])
      sessionStore.setQueueMessages(sidStr, queueRes.data || [])
      const sessRes = await api.get(`/sessions/${sessionId}`).catch(() => null)
      if (sessRes?.data?.phase) {
        sessionStore.updateSessionPhase(sidStr, sessRes.data.phase as any)
      }
      return true
    } catch {
      return false
    }
  }

  async function runRecovery() {
    if (!shouldUseNativeBridge() || recoveryInProgress) return
    recoveryInProgress = true
    try {
      const { connect } = useStreamWS()
      try {
        await connect() // 确保原生连接/服务已就绪
      } catch {
        // 连接失败：本次不恢复，下次回前台重试
        return
      }
      const bridge = getActiveBridge()
      if (!bridge) return
      const snap = await bridge.beginRecovery()
      if (!snap || !snap.active || !snap.recoveryId) return

      // REST 校准（部分失败保留待下次）
      const done: number[] = []
      for (const sid of snap.restSyncSessionIds) {
        if (await restCalibrate(sid)) done.push(sid)
      }
      if (done.length > 0) {
        await bridge.completeRestSync(snap.recoveryId, done)
      }
      await bridge.completeRecovery(snap.recoveryId)
    } catch (err) {
      console.warn('[app-resume] recovery failed:', err)
    } finally {
      recoveryInProgress = false
    }
  }

  function init() {
    if (initialized) return
    initialized = true
    if (!shouldUseNativeBridge()) return

    // 回前台触发恢复
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void runRecovery()
      }
    })

    // 冷启动：进程被回收重开 / 通知点击冷启动时页面初始化即为 visible，
    // visibilitychange 不会触发，须主动执行一次恢复（connect 会按需建桥）
    if (document.visibilityState === 'visible') {
      // 稍等应用挂载完成（Pinia store / 路由就绪）再跑
      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void runRecovery()
        }
      }, 300)
    }

    // 通知点击跳转（冷启动 getIntent / 热启动 onNewIntent → 插件 pendingNavigate）。
    // 桥可能尚未创建，通过模块级 handler 注册，桥创建后自动生效。
    setWsBridgeHandlers({
      onPendingNavigate: (sessionId: number) => {
        void router.push(`/tasks/${sessionId}`)
      }
    })
    // 若桥已存在，直接挂实例回调（recovery 相关由 runRecovery 驱动，此处仅导航）
    const bridge = getActiveBridge()
    if (bridge) {
      bridge.onPendingNavigate = (sessionId: number) => {
        void router.push(`/tasks/${sessionId}`)
      }
    }
  }

  return { init, runRecovery }
}
