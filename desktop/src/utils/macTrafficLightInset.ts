/**
 * macOS 窗口态左上角有红绿灯，顶栏要留白；进入全屏后系统收起红绿灯，按钮应贴左。
 * 原生全屏（绿按钮 / Electron setFullScreen）不走 Fullscreen API，渲染层只能看内容区是否铺满整屏。
 * 菜单栏约 24px、程序坞更高，2px 容差只吸收取整误差，不会把普通窗口或缩放窗口判成全屏。
 */
const SCREEN_FILL_TOLERANCE_PX = 2

export function isScreenFillingWindow(
  innerWidth: number,
  innerHeight: number,
  screenWidth: number,
  screenHeight: number,
): boolean {
  return Math.abs(innerWidth - screenWidth) <= SCREEN_FILL_TOLERANCE_PX
    && Math.abs(innerHeight - screenHeight) <= SCREEN_FILL_TOLERANCE_PX
}

export function readScreenFillingWindow(): boolean {
  if (typeof window === 'undefined') return false
  return isScreenFillingWindow(
    window.innerWidth,
    window.innerHeight,
    window.screen.width,
    window.screen.height,
  )
}

/** 仅 macOS 且未铺满整屏时为红绿灯留白。 */
export function reserveMacTrafficLightInset(isMac: boolean, screenFilling: boolean): boolean {
  return isMac && !screenFilling
}
