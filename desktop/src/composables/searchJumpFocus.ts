/**
 * 搜索跳转焦点交接（技术方案 2026-11-07 目标 5；review round1 Bug 1 / round2 Bug 2 修复）。
 *
 * handleJump 成功后焦点回到 TopNav 的搜索触发按钮，但目标视图「会话切换 / 面板挂载
 * 自动聚焦输入框」的既有联动（TaskView 路由 watcher → loadSession → nextTick、
 * ChatPanel restoreSession().finally → nextTick、SideChatPanel onMounted/onActivated →
 * nextTick——最终全部汇入 ChatInput.focusInput）会与 restoreFocus 双向竞争：
 *  - 跨页路径：联动晚于跳转完成运行（中间隔着真实网络往返），把焦点抢走；
 *  - 同页边路路径：联动（SideChatPanel 挂载聚焦）先于 restoreFocus 运行，且 tiptap v3
 *    focus 命令把真正的 view.focus() 推迟到 requestAnimationFrame——后写落在
 *    restoreFocus 之后，编辑器仍然收尾。
 * 固定延时赢不下网络往返，聚焦后重 assert 又会造成焦点抖动，故在源头让位：
 *
 *  1. 跳转在途窗口：handleJump 进入即开启、finally 关闭（同页边路分支的联动聚焦
 *     落在窗口内，被拦截后 rAF 后写不再被调度）；
 *  2. 停驻判定：焦点仍停在触发按钮上（= 跳转后用户尚未把焦点移去别处）时继续让位，
 *     覆盖窗口关闭后才运行的跨页联动；用户一旦移焦，条件自然失效，无计时器、无泄漏。
 * 用户主动触发的 focusInput（发送后回归、快捷起步等）发生时既不在窗口内、焦点也不在
 * 触发按钮上，不受影响。
 */
let jumpInFlight = false
let searchToggle: HTMLElement | null = null

/** SessionSearchPopover 挂载后登记触发按钮，卸载时传 null 注销。 */
export function registerSearchJumpFocusTarget(el: HTMLElement | null) {
  searchToggle = el
}

/** handleJump 进入即开启让位窗口（覆盖「联动聚焦先于 restoreFocus」的同页边路路径），finally 中关闭。 */
export function beginSearchJumpFocusWindow() {
  jumpInFlight = true
}

export function endSearchJumpFocusWindow() {
  jumpInFlight = false
}

/** focusInput 让位判定：跳转在途，或焦点已停驻触发按钮（跨页联动在窗口关闭后仍会运行）。 */
export function shouldDeferFocusToSearchJump(): boolean {
  return jumpInFlight || (searchToggle !== null && document.activeElement === searchToggle)
}
