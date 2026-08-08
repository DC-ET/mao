/**
 * 回前台恢复（仅安卓 Capacitor 平台）。
 *
 * 简化路线（docs/android-stability-heat-optimization-design.md）：
 * 删除原生保活后，后台 WebView 被系统冻结，JS 定时器停摆，连接在服务端 90s 空闲超时后断开。
 * 回前台时若检测到连接已断开（WS readyState 为 CLOSED/CLOSING），静默整页刷新恢复：
 * - 刷新后由现有 mao_last_session_id 还原最后会话并拉取最新状态；
 * - 若页面已彻底卡死（JS 无法执行），由 MainActivity 原生兜底探测并 reload。
 *
 * 不刷新的状态：-1（从未连接/已登出）、OPEN（连接正常）、CONNECTING（正在建连，打断有害）。
 *
 * 触发：document visibilitychange（visible）。冷启动时页面初始即为 visible，
 * 不会触发 visibilitychange，不会误判为「断开」而刷新；useChat 首次 connect() 建连。
 *
 * 防抖：10s 内不重复刷新，避免快速前后台切换触发连环刷新。
 * 冷启动防护：页面加载后 3s 内不触发（避免初始建连窗口误判）。
 */
import { useStreamWS } from './useStreamWS'
import { isAndroidCapacitor } from '../utils/capacitor'

let initialized = false
let lastReloadAt = 0

const RELOAD_DEBOUNCE_MS = 10_000
const COLD_START_GUARD_MS = 3_000
const bootAt = Date.now()

function maybeReload() {
  const now = Date.now()
  // 冷启动防护：页面加载初期不触发，避免建连窗口误判为断开
  if (now - bootAt < COLD_START_GUARD_MS) return
  // 防抖：快速前后台切换时最多 10s 刷新一次
  if (now - lastReloadAt < RELOAD_DEBOUNCE_MS) return

  // 仅在「已断开」时刷新：-1=从未连接/已登出（不刷新，交给 useChat 建连或保持登出）；
  // OPEN=连接正常；CONNECTING=正在建连（弱网重连中，打断反而有害）
  const state = useStreamWS().getReadyState()
  if (state === -1 || state === WebSocket.OPEN || state === WebSocket.CONNECTING) return

  lastReloadAt = now
  window.location.reload()
}

export function useForegroundRecovery() {
  function init() {
    if (initialized) return
    initialized = true
    if (!isAndroidCapacitor()) return
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        maybeReload()
      }
    })
  }

  return { init }
}
