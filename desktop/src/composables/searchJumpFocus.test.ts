// @vitest-environment jsdom
// 回归：搜索跳转焦点交接判定（composables/searchJumpFocus.ts）。
// 技术方案 docs/plan/2026-11-07-keyboard-focus-hit-area-technical-design.md 目标 5；
// review round1 Bug 1（跨页联动抢焦）+ round2 Bug 2（同页边路联动先于 restoreFocus 且
// tiptap rAF 后写）——「跳转在途窗口 + 焦点停驻判定」两个让位条件的语义在此锁定。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginSearchJumpFocusWindow,
  endSearchJumpFocusWindow,
  registerSearchJumpFocusTarget,
  shouldDeferFocusToSearchJump,
} from './searchJumpFocus'

describe('搜索跳转焦点交接判定', () => {
  beforeEach(() => {
    registerSearchJumpFocusTarget(null)
    endSearchJumpFocusWindow()
    document.body.innerHTML = ''
  })

  it('焦点停在登记的触发按钮上 → 停驻判定生效', () => {
    const toggle = document.createElement('div')
    toggle.tabIndex = 0
    document.body.appendChild(toggle)
    registerSearchJumpFocusTarget(toggle)
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    expect(shouldDeferFocusToSearchJump()).toBe(true)
  })

  it('焦点移到别处 → 停驻判定自然失效（无显式解除、无计时器）', () => {
    const toggle = document.createElement('div')
    toggle.tabIndex = 0
    const other = document.createElement('button')
    document.body.append(toggle, other)
    registerSearchJumpFocusTarget(toggle)
    toggle.focus()
    expect(shouldDeferFocusToSearchJump()).toBe(true)
    other.focus()
    expect(shouldDeferFocusToSearchJump()).toBe(false)
  })

  it('触发按钮未登记 / 已注销（null）→ 停驻判定一律 false', () => {
    const el = document.createElement('div')
    el.tabIndex = 0
    document.body.appendChild(el)
    el.focus()
    registerSearchJumpFocusTarget(null)
    expect(shouldDeferFocusToSearchJump()).toBe(false)
  })

  it('跳转在途窗口开启 → 无论焦点在哪一律让位；关闭后恢复按停驻判定', () => {
    const toggle = document.createElement('div')
    toggle.tabIndex = 0
    const other = document.createElement('button')
    document.body.append(toggle, other)
    registerSearchJumpFocusTarget(toggle)
    other.focus() // 焦点不在触发按钮（同页边路联动聚焦的调用时点）
    expect(shouldDeferFocusToSearchJump()).toBe(false)
    beginSearchJumpFocusWindow()
    expect(shouldDeferFocusToSearchJump(), '窗口内联动聚焦必须被拦截').toBe(true)
    endSearchJumpFocusWindow()
    expect(shouldDeferFocusToSearchJump()).toBe(false)
  })

  it('窗口关闭不影响停驻判定（跨页联动在窗口后仍被停驻条件拦截）', () => {
    const toggle = document.createElement('div')
    toggle.tabIndex = 0
    document.body.appendChild(toggle)
    registerSearchJumpFocusTarget(toggle)
    beginSearchJumpFocusWindow()
    toggle.focus() // restoreFocus
    endSearchJumpFocusWindow() // finally
    expect(shouldDeferFocusToSearchJump()).toBe(true)
  })
})
