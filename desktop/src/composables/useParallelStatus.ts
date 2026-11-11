import { computed, effectScope, getCurrentInstance, onUnmounted, ref, watch, type ComputedRef } from 'vue'
import { useSessionStore, ACTIVE_PHASES, type Session } from '../stores/session'
import { useAuthStore } from '../stores/auth'
import { approvalFlashEnabled } from '../utils/approvalFlashPreference'

/**
 * 多会话并行状态聚合（批次 29 提案 5）：标题态 + 任务栏闪烁的事实源。
 * 聚合口径与侧栏 TaskIndexPanel 同源——同一 store API（sessions / getSideTasks）、
 * 同一 ACTIVE_PHASES；侧栏的 SIDE_ACTIVE_PHASES 是组件局部常量且成员与 ACTIVE_PHASES 全同，
 * 这里统一用 store 导出的 ACTIVE_PHASES，不复制第二份。
 */

export type ParallelStatus = 'waiting_approval' | 'failed' | 'running' | null

/** 纯函数：主会话 + 边路任务的最高优先状态。ARCHIVED 主会话连同其边路任务整体跳过（侧栏 :308 口径）。 */
export function deriveParallelStatus(
  sessions: Session[],
  getSideTasks: (parentId: string) => Array<{ phase: Session['phase'] }>,
): ParallelStatus {
  const live = sessions.filter(s => s.status !== 'ARCHIVED')
  // 三轮独立扫描保证优先级严格成立：waiting 轮不短路到 failed。
  // 同一轮内「主会话 vs 边路」同态时按会话顺序取先命中者，无语义差异。
  for (const s of live) {
    if (s.phase === 'WAITING_APPROVAL' || getSideTasks(s.id).some(t => t.phase === 'WAITING_APPROVAL')) {
      return 'waiting_approval'
    }
  }
  for (const s of live) {
    if (s.phase === 'FAILED' || getSideTasks(s.id).some(t => t.phase === 'FAILED')) return 'failed'
  }
  for (const s of live) {
    if (ACTIVE_PHASES.has(s.phase) || getSideTasks(s.id).some(t => ACTIVE_PHASES.has(t.phase))) return 'running'
  }
  return null
}

export function useParallelStatus(): ComputedRef<ParallelStatus> {
  const sessionStore = useSessionStore()
  return computed(() => deriveParallelStatus(sessionStore.sessions, id => sessionStore.getSideTasks(id)))
}

export function titleWithPrefix(status: ParallelStatus, base = 'Mao'): string {
  const prefix = status === 'waiting_approval' ? '❗ 等待审批 · '
    : status === 'failed' ? '✗ 有会话失败 · '
    : status === 'running' ? '▶ 运行中 · '
    : ''
  return prefix + base
}

/** Electron 桥接：无 electronAPI（Web / 安卓）返回 null，flash 整体不启用（无 web 回退分支）。 */
function flashApi(): { flashFrame: (on: boolean) => Promise<unknown> } | null {
  const api = (window as any).electronAPI
  return api && typeof api.flashFrame === 'function' ? api : null
}

/**
 * 全局状态指示器（App.vue setup 调用一次）：
 * - 标题态：双源 watch（并行状态 + 登录态）每次触发都写（含 immediate 首跑）——登出必复位 `Mao`；
 *   登录页 / 飞书回调页自身不引起两源变化，其静态标题不被抢。
 * - 任务栏闪烁：期望态沿检测——desired = 等待审批 && 开关开 && 桥接存在；
 *   false→true 沿 flash(true)、true→false 沿 flash(false)；immediate 使「启动时已有等待审批」
 *   视为进入沿（首跑 desired=false 且 prev 为 undefined 时跳过，省一次无害 IPC）。
 *
 * watcher 注册进独立 effectScope（不在组件作用域内），返回 stop 供测试显式销毁；
 * 组件环境（App.vue）下随 App unmount 自动 stop（防御性，App 实际常驻）。
 */
export function useAppStatusIndicators(): () => void {
  const status = useParallelStatus()
  const authStore = useAuthStore()
  const flashing = ref(false)

  const scope = effectScope()
  scope.run(() => {
    watch([status, () => authStore.user], ([value, user]) => {
      document.title = user ? titleWithPrefix(value) : titleWithPrefix(null)
    }, { immediate: true }) // 挂载即写：App 启动/恢复时已存在的等待审批立即带前缀（与 flash immediate 同源语义）

    const desiredFlash = computed(() =>
      status.value === 'waiting_approval' && approvalFlashEnabled.value && !!flashApi()
    )
    watch(desiredFlash, (now, prev) => {
      const api = flashApi()
      if (!api) return
      if (!now && prev === undefined) return // 启动首跑的空闲态：不向主进程发复位 IPC
      flashing.value = now
      void api.flashFrame(now).catch(() => undefined)
    }, { immediate: true })
  })

  const stop = () => {
    scope.stop()
    if (!flashing.value) return
    flashing.value = false
    void flashApi()?.flashFrame(false).catch(() => undefined)
  }
  if (getCurrentInstance()) onUnmounted(stop)

  return stop
}
