// @vitest-environment jsdom
// 回归：搜索跳转「焦点回归触发按钮」与目标视图自动聚焦的双向竞争
// （技术方案 docs/plan/2026-11-07-keyboard-focus-hit-area-technical-design.md 目标 5；
//   review round1 Bug 1：跨页路径联动晚于 restoreFocus 运行（网络往返后）抢焦；
//   review round2 Bug 2：同页边路路径联动先于 restoreFocus 运行，且 tiptap v3 focus
//   命令把真实 view.focus() 推迟到 requestAnimationFrame，后写落在 restoreFocus 之后——
//   因此联动聚焦链必须建模 rAF 时延，普通 .focus() 复刻不出该竞争）。
//
// 联动的最终汇聚点是 ChatInput.focusInput（TaskView/ChatPanel/SideChatPanel 全部经由它），
// 修复 = focusInput 内的让位守卫（跳转在途窗口 + 焦点停驻判定，真实调用
// composables/searchJumpFocus）；接线由 chat-a11y.test.ts 源码断言锁定。
import { beforeEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import {
  beginSearchJumpFocusWindow,
  endSearchJumpFocusWindow,
  registerSearchJumpFocusTarget,
  shouldDeferFocusToSearchJump,
} from '../../composables/searchJumpFocus'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** jsdom 可能无 rAF：降级为 16ms 宏任务，保持「一帧后写」的时序语义。 */
const nextFrame = () => new Promise<void>((resolve) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
  else setTimeout(resolve, 16)
})

function mountHarness() {
  const toggle = document.createElement('div')
  toggle.className = 'theme-toggle search-toggle'
  toggle.tabIndex = 0
  const chatInput = document.createElement('input')
  chatInput.className = 'stub-chat-input'
  document.body.append(toggle, chatInput)
  registerSearchJumpFocusTarget(toggle)
  return { toggle, chatInput }
}

/** 复刻 TaskView.vue:1546-1551 / ChatPanel.vue:449-453 / SideChatPanel.vue:770 的联动聚焦链
 * （守卫为真实调用；tiptap 的 rAF 后写一并建模）。 */
async function targetViewAutoFocusChain(chatInput: HTMLInputElement) {
  await sleep(8) // 路由联动 / loadSession 网络往返（宏任务，时长不定——固定延时方案因此不可靠）
  await nextTick()
  // ChatInput.focusInput 的让位守卫（源码接线由 chat-a11y.test.ts 锁定）
  if (shouldDeferFocusToSearchJump()) return
  // tiptap v3 focus 命令把真实 view.focus() 推迟到 rAF（round2 Bug 2 的关键时延）
  await nextFrame()
  chatInput.focus()
}

describe('搜索跳转焦点交接：restoreFocus vs 目标视图联动聚焦', () => {
  beforeEach(() => {
    registerSearchJumpFocusTarget(null)
    endSearchJumpFocusWindow()
    document.body.innerHTML = ''
  })

  it('跨页路径（联动晚于 restoreFocus）：窗口关闭后由停驻判定让位，焦点停在触发按钮', async () => {
    const { toggle, chatInput } = mountHarness()
    beginSearchJumpFocusWindow() // handleJump 进入
    await sleep(8) // await router.push 期间
    toggle.focus() // restoreFocus()
    endSearchJumpFocusWindow() // finally
    expect(document.activeElement).toBe(toggle)
    // 目标视图联动随后运行（真实场景晚数十~数百 ms）
    await targetViewAutoFocusChain(chatInput)
    expect(document.activeElement, '跨页联动聚焦不得抢走停驻在触发按钮上的焦点').toBe(toggle)
  })

  it('同页边路路径（联动先于 restoreFocus，round2 Bug 2）：窗口内拦截，rAF 后写不再调度', async () => {
    const { toggle, chatInput } = mountHarness()
    beginSearchJumpFocusWindow() // handleJump 进入；openSideTaskTabFor → replace 之间面板挂载聚焦
    await targetViewAutoFocusChain(chatInput) // 联动聚焦落在窗口内 → 守卫拦截
    expect(document.activeElement, '窗口内联动聚焦不得落到编辑器').not.toBe(chatInput)
    toggle.focus() // await router.replace 解析 → restoreFocus()
    endSearchJumpFocusWindow() // finally
    // 再排空一帧：确认没有已调度的 rAF 后写把焦点抢走（修复前的失败点）
    await nextFrame()
    await nextFrame()
    expect(document.activeElement).toBe(toggle)
  })

  it('用户已把焦点移走：联动聚焦照常执行，不被抑制', async () => {
    const { toggle, chatInput } = mountHarness()
    const sidebarBtn = document.createElement('button')
    document.body.appendChild(sidebarBtn)
    beginSearchJumpFocusWindow()
    toggle.focus()
    endSearchJumpFocusWindow()
    sidebarBtn.focus() // 用户在联动完成前点了侧栏
    await targetViewAutoFocusChain(chatInput)
    expect(document.activeElement).toBe(chatInput)
  })

  it('!rootId 早退：窗口经 finally 关闭，焦点不动也不残留让位状态', () => {
    const { chatInput } = mountHarness()
    chatInput.focus() // 跳转前焦点在对话框内输入类元素
    beginSearchJumpFocusWindow()
    endSearchJumpFocusWindow() // !rootId return → finally 关窗（不 restoreFocus）
    expect(shouldDeferFocusToSearchJump()).toBe(false)
    expect(document.activeElement).toBe(chatInput)
  })

  it('用户主动聚焦（发送后回归/快捷起步）发生在窗口外且焦点不在触发按钮 → 不受让位影响', () => {
    const { toggle, chatInput } = mountHarness()
    toggle.focus()
    chatInput.focus() // 用户主动动作已把焦点移走
    expect(shouldDeferFocusToSearchJump()).toBe(false)
  })
})
