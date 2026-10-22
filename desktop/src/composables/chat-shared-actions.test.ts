// 回归：对话区共用的会话动作必须保持单一实现，禁止再复制回两侧组件。
// 背景：队列操作、上传防线、等待落库、取消收尾曾经各写一份，已经分叉出真实行为差异
// （边路停止后不清理流式气泡、上传失败无提示、部分失败无二次确认）。桌面 vitest 是
// node 环境，与 chat-scroll-shared.test.ts 同法用源码结构断言锁死契约。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chatPanel = readFileSync(new URL('../components/chat/ChatPanel.vue', import.meta.url), 'utf8')
const sidePanel = readFileSync(new URL('../components/chat/SideChatPanel.vue', import.meta.url), 'utf8')
const useChat = readFileSync(new URL('./useChat.ts', import.meta.url), 'utf8')

const PANELS: Array<[string, string]> = [['ChatPanel', chatPanel], ['SideChatPanel', sidePanel]]

describe('会话动作共用同一实现', () => {
  it('两个面板都不再自备队列操作与撤回编辑', () => {
    for (const [name, src] of PANELS) {
      expect(src, `${name} 未复用 useChatQueue`).toContain('useChatQueue(')
      for (const fn of ['insertQueueMessage', 'deleteQueueMessage', 'reorderQueueMessage', 'handleQueueEdit', 'fetchQueue']) {
        expect(src, `${name} 仍自带 ${fn}`).not.toContain(`async function ${fn}(`)
      }
    }
  })

  it('useChat 不再自备队列操作与上传防线', () => {
    for (const fn of ['insertQueueMessage', 'deleteQueueMessage', 'reorderQueueMessage', 'fetchQueue', 'guardUploadsBeforeSend']) {
      expect(useChat, `useChat 仍自带 ${fn}`).not.toContain(`async function ${fn}(`)
    }
    expect(useChat).toContain('useChatQueue(')
    expect(useChat).toContain('waitForMessageSaved(')
    expect(useChat).toContain('finalizeCancelledSession(')
    expect(useChat).toContain('awaitExecutionSettled(')
  })

  it('边路接入同一套上传防线 / 落库等待 / 取消收尾 / 重试等待', () => {
    expect(sidePanel).toContain('guardUploadsBeforeSend({')
    expect(sidePanel).toContain('waitForMessageSaved(')
    expect(sidePanel).toContain('finalizeCancelledSession(')
    expect(sidePanel).toContain('awaitExecutionSettled(')
    // 旧的裸 return 防线已删除（失败时既无提示也无二次确认）
    expect(sidePanel).not.toContain('if (files.length > 0 && imageUrls.length === 0) {')
  })
})
