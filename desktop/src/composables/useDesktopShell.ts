import { ElMessage } from 'element-plus'

/**
 * 桌面壳事件桥接（P2/P3）：主进程 → 渲染层的单向事件。
 * - `tray-new-task`：托盘「新建任务」→ 复用既有入口（Home + newTask=1 路由，TaskView 自行进入新建态）
 * - `tray-first-close-hint`：首次关窗隐藏到托盘的一次性提示（主进程 trayHintShown 持久化，只发一次）
 * - `desktop-shortcut-failed`：全局快捷键注册失败（被占用 / 格式非法）→ 设置页外也能看到红字提示
 *
 * 幂等注册（模块级单例），由 useStreamWS() 首次调用时触发；Web/安卓无 electronAPI 时整体空转。
 */

const NEW_TASK_QUERY = 'newTask'

let bridgeSetup = false

function shellApi() {
  const api = (window as any).electronAPI
  return api && typeof api.onTrayNewTask === 'function' ? api : null
}

function ensureDesktopShellBridge(): void {
  if (bridgeSetup) return
  const api = shellApi()
  if (!api) return
  bridgeSetup = true

  if (typeof api.onTrayNewTask === 'function') {
    api.onTrayNewTask(() => {
      void (async () => {
        const { default: router } = await import('../router')
        // 推到 Home + newTask=1：TaskView 路由监听据此进入新建任务态（复用既有入口）；
        // 已在目标路由时 push 为冗余导航（no-op），无副作用
        await router.push({ name: 'Home', query: { [NEW_TASK_QUERY]: '1' } })
      })()
    })
  }

  if (typeof api.onTrayFirstCloseHint === 'function') {
    api.onTrayFirstCloseHint(() => {
      ElMessage.info({
        message: '已最小化到托盘，任务完成会通知你；彻底退出请用托盘菜单',
        duration: 5000,
      })
    })
  }

  if (typeof api.onDesktopShortcutFailed === 'function') {
    api.onDesktopShortcutFailed((payload: { accel?: string; error?: string }) => {
      const accel = payload?.accel ? `（${payload.accel}）` : ''
      ElMessage.error(`快捷键注册失败${accel}：${payload?.error || '可能被其他程序占用'}`)
    })
  }
}

/** 测试辅助：重置注册标记。 */
export function resetDesktopShellBridgeForTest(): void {
  bridgeSetup = false
}

/** 由 useStreamWS() 首次调用触发（登录后 WS 单例即活跃）。 */
export function ensureDesktopShellBridgeFromWs(): void {
  ensureDesktopShellBridge()
}
