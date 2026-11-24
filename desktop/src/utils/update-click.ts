/** 客户端更新状态（与 useVersionCheck 的 appUpdateStatus 保持一致） */
export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error'
  | 'unsupported'

/** 顶栏刷新按钮的点击语义 */
export type UpdateClickAction =
  | 'install'         // 客户端更新已下载，弹「重启安装」
  | 'android-prompt'  // 安卓 OTA 有包，弹更新确认
  | 'progress'        // 客户端更新正在下载，只提示进度，不打断下载
  | 'reload'          // 刷新页面

/**
 * 刷新按钮点击决策。
 *
 * 除「已下载待安装」与「客户端更新下载中」两类会打断升级流程的状态外，一律刷新页面。
 * 这里不能先 await 更新检查：更新源故障（latest.yml 404）或检查请求挂起时，
 * 按钮会完全无响应，用户连刷新页面都做不到。页面重载后 TopNav 挂载会立即重新检查
 * 客户端更新，因此刷新不会漏掉新版本。
 */
export function resolveUpdateClickAction(state: {
  downloaded: boolean
  available: boolean
  status: AppUpdateStatus
  android: boolean
}): UpdateClickAction {
  if (state.downloaded || state.status === 'downloaded') return 'install'
  if (state.status === 'downloading') return 'progress'
  if (state.available || state.status === 'available') {
    return state.android ? 'android-prompt' : 'progress'
  }
  return 'reload'
}

/**
 * 更新检查失败时的 tooltip 文案。
 * 上游错误常是整段 HttpError + URL，直接塞进 tooltip 会撑满窗口，这里只留首行并限长。
 */
export function summarizeUpdateError(message: string | null | undefined, limit = 60): string {
  const firstLine = String(message || '').split(/\r?\n/)[0].replace(/\s+/g, ' ').trim()
  if (!firstLine) return '客户端更新检查失败，点击刷新页面'
  const text = firstLine.length > limit ? `${firstLine.slice(0, limit)}…` : firstLine
  return `客户端更新检查失败：${text}（点击刷新页面）`
}