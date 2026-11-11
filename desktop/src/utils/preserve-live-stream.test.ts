import { describe, expect, it } from 'vitest'
import { shouldPreserveLiveStreamOnFetch } from './preserve-live-stream'
import type { ChatMessage } from '../types/chat'

function assistant(toolStatus?: 'pending' | 'running' | 'success'): ChatMessage {
  return {
    id: 'msg_1_assistant',
    role: 'assistant',
    content: '中间步骤',
    createdAt: '2026-11-11 11:10:00',
    toolCalls: toolStatus
      ? [{ id: 't1', name: 'shell', status: toolStatus, isExpanded: false, argsStreaming: false }]
      : [],
  }
}

const user: ChatMessage = {
  id: '100',
  role: 'user',
  content: '重新部署前后端服务',
  createdAt: '2026-11-11 11:09:50',
}

describe('终态历史重拉是否保留本地流式气泡', () => {
  it('终态即使仍在 streaming 也不保留（REST 是权威）', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: 'COMPLETED',
      streaming: true,
      lastMessage: assistant('running'),
    })).toBe(false)
  })

  it('终态 + 尾部 running 工具（部署重启留下的旧执行）不保留', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: 'COMPLETED',
      streaming: false,
      lastMessage: assistant('running'),
    })).toBe(false)
  })

  it('执行中 + 尾部 running 工具仍保留（重连后回显执行中工具）', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: 'RUNNING',
      streaming: false,
      lastMessage: assistant('running'),
    })).toBe(true)
  })

  it('RESUMING（续跑中）按活跃处理，保留流式气泡', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: 'RESUMING',
      streaming: true,
      lastMessage: assistant(),
    })).toBe(true)
  })

  it('phase 未知时维持旧行为，避免误伤刚建立的真实流式', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: null,
      streaming: false,
      lastMessage: assistant('pending'),
    })).toBe(true)
  })

  it('只有乐观用户消息 / 无工具进行中时不保留', () => {
    expect(shouldPreserveLiveStreamOnFetch({
      phase: 'RUNNING',
      streaming: false,
      lastMessage: user,
    })).toBe(false)
    expect(shouldPreserveLiveStreamOnFetch({
      phase: null,
      streaming: false,
      lastMessage: assistant('success'),
    })).toBe(false)
  })
})
