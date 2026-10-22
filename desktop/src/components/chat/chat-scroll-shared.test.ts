// 回归：边路任务 / 子代理两个面板必须复用主会话的 useChatScroll，禁止再各自复制一套滚动实现。
// 背景：两处手工复制的实现缺少 generation / 恢复期保护 / 发送即跟随等语义，长期与主会话漂移，
// 表现为「发送消息后停在页面中部、后续流式也不再跟随」。桌面 vitest 是 node 环境、无法挂载
// 组件，与 chat-share-entry.test.ts 同法用源码结构断言锁死契约。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sidePanel = readFileSync(new URL('./SideChatPanel.vue', import.meta.url), 'utf8')
const subagentPanel = readFileSync(new URL('./SubagentChatPanel.vue', import.meta.url), 'utf8')
const chatPanel = readFileSync(new URL('./ChatPanel.vue', import.meta.url), 'utf8')
const useChatScroll = readFileSync(new URL('../../composables/useChatScroll.ts', import.meta.url), 'utf8')

/** 取出某个函数的函数体（到下一个顶层 `}` 为止） */
function fnBody(src: string, signature: string): string {
  const start = src.indexOf(signature)
  expect(start, `未找到 ${signature}`).toBeGreaterThanOrEqual(0)
  const end = src.indexOf('\n}', start)
  return src.slice(start, end)
}

describe('对话区自动滚动共用 useChatScroll', () => {
  it('三个面板都调用同一个组合式函数，不再各自维护 userScrolledUp 状态机', () => {
    for (const [name, src] of [['ChatPanel', chatPanel], ['SideChatPanel', sidePanel], ['SubagentChatPanel', subagentPanel]] as const) {
      expect(src, `${name} 未复用 useChatScroll`).toContain('useChatScroll(messagesContainer')
      expect(src, `${name} 仍自带 userScrolledUp 状态`).not.toContain('const userScrolledUp = ref(false)')
      expect(src, `${name} 仍自带 scrollToBottom 实现`).not.toContain('function scrollToBottom()')
    }
  })

  it('useChatScroll 暴露 resumeFollow：显式恢复跟随（发送 / 切回 Tab / 回到最新）', () => {
    expect(useChatScroll).toContain('function resumeFollow()')
    // 必须先复位再定位，否则 scrollToBottom 内部的上滑守卫会把这次定位吞掉
    const body = fnBody(useChatScroll, 'function resumeFollow()')
    expect(body).toContain('userScrolledUp.value = false')
    expect(body).toContain('scrollToBottom()')
    expect(useChatScroll).toContain('resumeFollow, scrollToMessage')
  })

  it('边路发送链路（首发 / 普通 / 入队）都恢复跟随并补定位', () => {
    const send = fnBody(sidePanel, 'async function handleChatSend(')
    // 发送即跟随：入口先复位，尾部与入队分支各补一次定位
    expect(send).toContain('resumeFollow()')
    expect(send.match(/scrollToBottom\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // 入队分支（执行中发送）不能漏：QueuePanel 出现会压缩消息区
    const enqueueStart = send.indexOf('enqueueMessage(')
    expect(enqueueStart).toBeGreaterThanOrEqual(0)
    expect(send.slice(enqueueStart, enqueueStart + 700)).toContain('scrollToBottom()')
  })

  it('两个复用方都正确绑定手势与销毁，避免监听泄漏', () => {
    for (const [name, src] of [['SideChatPanel', sidePanel], ['SubagentChatPanel', subagentPanel]] as const) {
      expect(src, `${name} 未绑定 wheel`).toContain("addEventListener('wheel', handleWheel")
      expect(src, `${name} 未绑定触摸手势`).toContain('handleTouchStart')
      expect(src, `${name} 未解绑 wheel`).toContain("removeEventListener('wheel', handleWheel")
      expect(src, `${name} 未释放滚动生命周期`).toContain('disposeScroll()')
      expect(src, `${name} 未在切回时恢复跟随`).toContain('resumeFollow()')
    }
  })
})
