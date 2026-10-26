/**
 * 桌面壳（Electron）相关契约类型：preload 暴露的窗口 API 与主进程事件载荷。
 * 放独立模块（electron.d.ts 是环境声明文件，不能 import；这里用行内 import 类型引用）。
 */

/** LOCAL 附件拷贝入参（P1）：落点由主进程按 home + server host + sessionId 推导 */
export interface LocalCopyAttachmentParams {
  sourcePath: string
  sessionId: number
  maxSizeMb?: number
}

export interface LocalCopyAttachmentResult {
  ok: boolean
  /** 拷贝后的绝对路径（<home>/.mao/attachments/<host>/<sid>/<name>） */
  absolutePath?: string
  error?: string
}

/** 桌面通知载荷（P2） */
export interface DesktopNotifyPayload {
  title: string
  body?: string
  tag?: string
  itemId?: number | null
  sessionId?: number | null
}

export interface DesktopNotifyResult {
  ok: boolean
  error?: string
}

export interface DesktopNotificationClickPayload {
  itemId?: number | null
  sessionId?: number | null
}

export interface DesktopNotifyResultPayload {
  ok: boolean
  error?: string
  tag?: string
}

/** 桌面偏好（P2/P3，机器级：不随服务器切换、登出不清） */
export interface DesktopPrefs {
  closeToTray: 'quit' | 'tray'
  trayHintShown: boolean
  globalShortcut: string | null
  autoStart: boolean
}

export interface DesktopPrefsGetResult {
  ok: boolean
  prefs: DesktopPrefs
  /** 是否打包后运行：dev 模式下自启开关禁用 */
  packaged: boolean
  platform: string
}

export interface DesktopPrefsSetResult {
  ok: boolean
  prefs?: DesktopPrefs
  /** 副作用（自启应用）失败时的提示；偏好本身已落盘 */
  error?: string
}

export interface DesktopShortcutFailedPayload {
  accel?: string | null
  error?: string
}
