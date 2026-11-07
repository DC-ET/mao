// @vitest-environment jsdom
// 2026-11-07 逻辑 BUG 审查——存在性证明用例（详见 docs/code-review/2026-11-07-logic-bug-review-01.md BUG-7）。
//
// 用例断言「正确行为」，当前实现必然失败，默认以 it.fails 固化（CI 保持绿色）。
// 把顶部的 `const bugIt = it.fails;` 改成 `const bugIt = it;` 再运行即得真实失败：
//
//   cd desktop
//   sed -i '' 's/^const bugIt = it.fails;$/const bugIt = it;/' src/composables/searchJumpFocus.bugcheck.test.ts
//   npx vitest run src/composables/searchJumpFocus.bugcheck.test.ts
//   sed -i '' 's/^const bugIt = it;$/const bugIt = it.fails;/' src/composables/searchJumpFocus.bugcheck.test.ts
//
// BUG：searchJumpFocus 的「停驻判定」以 document.activeElement === 搜索触发按钮
// 作为「用户尚未移焦」的代理。但 Chromium 里点击不可聚焦元素（生产 DOM：任务列表
// .session-item 是无 tabindex 的 div，TaskSessionGroupList.vue:97-107）不移动焦点，
// 于是「搜索跳转 → 点侧栏切会话」这条最高频路径上 activeElement 仍停在触发按钮：
// 会话切换联动的 ChatInput.focusInput（ChatInput.vue:1234）被永久让位，输入框不聚焦、
// 键入无落点，且后续每次切会话的自动聚焦都被吞，直到用户恰好点到可聚焦元素。
// searchJumpFocus.ts 头注释声明的语义「用户一旦移焦，条件自然失效」在该路径上不成立。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  endSearchJumpFocusWindow,
  registerSearchJumpFocusTarget,
  shouldDeferFocusToSearchJump,
} from './searchJumpFocus'

const bugIt = it.fails

describe('搜索跳转停驻判定：点击不可聚焦元素应解除让位', () => {
  beforeEach(() => {
    registerSearchJumpFocusTarget(null)
    endSearchJumpFocusWindow()
    document.body.innerHTML = ''
  })

  bugIt('跳转后点击侧栏会话项（无 tabindex 的 div，生产 DOM 形态）→ 停驻判定应失效', () => {
    const toggle = document.createElement('div')
    toggle.tabIndex = 0
    // 生产 TaskSessionGroupList.vue 的 .session-item：div + @click，无 tabindex
    const sessionItem = document.createElement('div')
    document.body.append(toggle, sessionItem)
    registerSearchJumpFocusTarget(toggle)

    toggle.focus() // handleJump 成功 → restoreFocus 把焦点放回触发按钮
    expect(shouldDeferFocusToSearchJump()).toBe(true)

    // 用户点击侧栏会话项切换会话（bubbles 的 click 不足以移动焦点，与 Chromium 一致）
    sessionItem.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.activeElement).toBe(toggle)

    // 正确语义：用户已通过点击选择了会话（移焦动作），此后的联动 focusInput 不得再被让位拦截
    expect(shouldDeferFocusToSearchJump()).toBe(false)
  })
})
