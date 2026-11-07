// 回归：键盘、焦点与命中区可达性（技术方案 docs/plan/2026-11-07-keyboard-focus-hit-area-technical-design.md）。
//
// 六组断点全为纯桌面端属性/样式/焦点逻辑（零后端、零迁移），组件无挂载测试先例，
// 故与 SignalWatchersView.layout.test.ts 同构：readFileSync 源码级静态断言，锁死本次修复不退化。
//   1. 发送后焦点回归输入框（ChatInput.handleSend 尾部 focusInput()）
//   2. 「已执行 N 个步骤」折叠块键盘可达（div→button + aria-expanded + :focus-visible）
//   3. 复制按钮可访问名称（title + aria-label）
//   4. 触屏命中区（pointer: coarse 下 44px 命中泡 / 32px 实体内扩）
//   5. 搜索跳转后焦点回归触发按钮（restoreFocus 闭环 + !rootId 早退不调用）
//   6. 动态状态播报（queue-title / typing-indicator 的 role="status"）
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const messageBubbleSrc = read('./MessageBubble.vue')
const chatRoundListSrc = read('./ChatRoundList.vue')
const chatInputSrc = read('./ChatInput.vue')
const searchPopoverSrc = read('../search/SessionSearchPopover.vue')
const queuePanelSrc = read('./QueuePanel.vue')
const chatPanelSrc = read('./ChatPanel.vue')

/** 取从 `startMarker` 起到函数体闭合（行首 `}`）为止的源码片段。 */
function functionBody(src: string, startMarker: string): string {
  const at = src.indexOf(startMarker)
  expect(at, `未找到 ${startMarker}`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}', at)
  expect(end, `${startMarker} 未找到闭合}`).toBeGreaterThan(-1)
  return src.slice(at, end)
}

describe('聊天可达性回归（键盘/焦点/命中区）', () => {
  it('发送后焦点回归输入框：handleSend 内 emit(send) 之后调用 focusInput()', () => {
    const body = functionBody(chatInputSrc, 'async function handleSend')
    const emitAt = body.indexOf("emit('send'")
    expect(emitAt, 'handleSend 内未找到 emit(send)').toBeGreaterThan(-1)
    const focusAt = body.indexOf('focusInput()')
    expect(focusAt, 'emit(send) 之后未紧跟 focusInput()').toBeGreaterThan(emitAt)
  })

  it('步骤折叠块键盘可达：steps-summary 为 button 且带 aria-expanded，样式含 :focus-visible', () => {
    const tagAt = chatRoundListSrc.indexOf('<button type="button" class="steps-summary"')
    expect(tagAt, 'steps-summary 未改为 button').toBeGreaterThan(-1)
    const tag = chatRoundListSrc.slice(tagAt, chatRoundListSrc.indexOf('>', tagAt))
    expect(tag).toContain(':aria-expanded=')
    expect(chatRoundListSrc).toContain('.steps-summary:focus-visible')
    // button 显式重置齐备（缺一则露出 UA 默认外观：灰色底/outset 边框/系统字体）
    const styleAt = chatRoundListSrc.indexOf('.execution-steps-collapse .steps-summary {')
    const styleBlock = chatRoundListSrc.slice(styleAt, chatRoundListSrc.indexOf('}', styleAt))
    for (const decl of ['font: inherit', 'text-align: left', 'border: 0', 'background: var(--aw-canvas-parchment)', 'padding: 6px 12px', 'cursor: pointer']) {
      expect(styleBlock, `steps-summary 样式缺少 ${decl}`).toContain(decl)
    }
  })

  it('复制按钮有可访问名称：copy-btn 开标签含动态 title（已复制分支）与 aria-label', () => {
    const tagAt = messageBubbleSrc.indexOf('<button class="copy-btn"')
    expect(tagAt, '未找到 copy-btn').toBeGreaterThan(-1)
    const tag = messageBubbleSrc.slice(tagAt, messageBubbleSrc.indexOf('>', tagAt))
    expect(tag).toContain(`:title="copied ? '已复制' : '复制消息'"`)
    expect(tag).toContain('aria-label="复制消息"')
  })

  it('触屏命中区：search-close 44px 命中泡 + message-footer/queue 操作钮 32px 实体内扩（仅 coarse）', () => {
    // search-close 命中泡：紧跟其基础规则之后（照抄同文件 .search-toggle 既有模式）
    const closeAt = searchPopoverSrc.indexOf('.session-search-dialog .search-close {')
    expect(closeAt, '未找到 search-close 规则').toBeGreaterThan(-1)
    const afterClose = searchPopoverSrc.slice(closeAt, closeAt + 800)
    const mediaAt = afterClose.indexOf('@media (pointer: coarse)')
    expect(mediaAt, 'search-close 规则后未找到 coarse 命中泡').toBeGreaterThan(-1)
    const mediaBlock = afterClose.slice(mediaAt, mediaAt + 400)
    expect(mediaBlock).toContain('.search-close::before')
    expect(mediaBlock).toContain('44px')

    // 密集操作行：实体内扩 32px
    const bubbleMediaAt = messageBubbleSrc.indexOf('@media (pointer: coarse)')
    expect(bubbleMediaAt, 'MessageBubble 缺 coarse 内扩').toBeGreaterThan(-1)
    const bubbleMedia = messageBubbleSrc.slice(bubbleMediaAt, bubbleMediaAt + 300)
    expect(bubbleMedia).toContain('.message-footer button')
    expect(bubbleMedia).toContain('32px')

    const queueMediaAt = queuePanelSrc.indexOf('@media (pointer: coarse)')
    expect(queueMediaAt, 'QueuePanel 缺 coarse 内扩').toBeGreaterThan(-1)
    const queueMedia = queuePanelSrc.slice(queueMediaAt, queueMediaAt + 300)
    expect(queueMedia).toContain('.queue-item-actions .action-btn')
    expect(queueMedia).toContain('32px')
  })

  it('搜索跳转焦点闭环：触发按钮可聚焦可键盘激活，handleJump 成功路径调 restoreFocus 且早退在其前', () => {
    expect(searchPopoverSrc).toContain('ref="searchToggleRef"')
    expect(searchPopoverSrc).toContain('tabindex="0"')
    expect(searchPopoverSrc).toContain('@keydown.enter.prevent="openSearch"')
    expect(searchPopoverSrc).toContain('@keydown.space.prevent="openSearch"')
    expect(searchPopoverSrc).toContain('searchToggleRef.value?.focus()')

    const body = functionBody(searchPopoverSrc, 'async function handleJump')
    const earlyReturnAt = body.indexOf('if (!rootId) return')
    expect(earlyReturnAt, 'handleJump 缺 !rootId 早退').toBeGreaterThan(-1)
    const restoreAt = body.indexOf('restoreFocus()')
    expect(restoreAt, 'handleJump 未调用 restoreFocus()').toBeGreaterThan(earlyReturnAt)
  })

  it('搜索跳转焦点交接接线：focusInput 让位守卫 + 触发按钮登记/注销 + 跳转在途窗口', () => {
    // 让位守卫必须在 focusInput 函数体内——TaskView/ChatPanel/SideChatPanel 的联动聚焦
    // 全部汇聚于此（review round1 Bug 1：联动晚于跳转完成运行会被抢焦；round2 Bug 2：
    // 同页边路联动先于 restoreFocus 且经 tiptap rAF 后写，须由在途窗口拦截）
    const focusFn = functionBody(chatInputSrc, 'function focusInput')
    expect(focusFn).toContain('shouldDeferFocusToSearchJump()')
    expect(searchPopoverSrc).toContain('registerSearchJumpFocusTarget(searchToggleRef.value)')
    expect(searchPopoverSrc).toContain('registerSearchJumpFocusTarget(null)')
    const jumpBody = functionBody(searchPopoverSrc, 'async function handleJump')
    expect(jumpBody.indexOf('beginSearchJumpFocusWindow()'), 'handleJump 须先开让位窗口').toBeGreaterThan(-1)
    expect(jumpBody.indexOf('endSearchJumpFocusWindow()'), '让位窗口须在 finally 关闭（!rootId 早退也覆盖）')
      .toBeGreaterThan(jumpBody.indexOf('beginSearchJumpFocusWindow()'))
  })

  it('动态状态播报：queue-title 与 typing-indicator 带 role="status"', () => {
    const titleAt = queuePanelSrc.indexOf('<span class="queue-title"')
    expect(titleAt, '未找到 queue-title').toBeGreaterThan(-1)
    const titleTag = queuePanelSrc.slice(titleAt, queuePanelSrc.indexOf('>', titleAt))
    expect(titleTag).toContain('role="status"')
    expect(titleTag).toContain('aria-live="polite"')

    const typingAt = chatPanelSrc.indexOf('class="typing-indicator"')
    expect(typingAt, '未找到 typing-indicator').toBeGreaterThan(-1)
    const typingTagStart = chatPanelSrc.lastIndexOf('<div', typingAt)
    const typingTag = chatPanelSrc.slice(typingTagStart, chatPanelSrc.indexOf('>', typingAt))
    expect(typingTag).toContain('role="status"')
    expect(typingTag).toContain('aria-label="Agent 正在执行"')
  })
})
