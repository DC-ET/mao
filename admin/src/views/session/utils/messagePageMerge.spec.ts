import { describe, expect, it } from 'vitest'
import { mergeLatestPage } from './messagePageMerge'
import type { ChatMessage } from '../types/chat'

function msg(id: string, role: ChatMessage['role'], content = ''): ChatMessage {
  return { id, role, content, createdAt: '2026-01-01 00:00:00' }
}

const ids = (messages: ChatMessage[]): string[] => messages.map((message) => message.id)

describe('mergeLatestPage（轮询静默刷新）', () => {
  it('轮询期间新开一轮：上一轮不能被删掉', () => {
    const current = [msg('1', 'user', 'U1'), msg('2', 'assistant', 'A1'), msg('3', 'user', 'U2'), msg('4', 'assistant', 'A2')]
    const latest = [msg('5', 'user', 'U3')]
    expect(ids(mergeLatestPage(current, latest))).toEqual(['1', '2', '3', '4', '5'])
  })

  it('同一轮内刷新：用 latest 覆盖该轮（新增工具结果/更新内容）', () => {
    const current = [msg('1', 'user', 'U1'), msg('2', 'assistant', 'A1'), msg('3', 'user', 'U2'), msg('4', 'assistant', 'A2')]
    const latest = [msg('3', 'user', 'U2'), msg('4', 'assistant', 'A2 已更新'), msg('5', 'assistant', 'TOOL')]
    const merged = mergeLatestPage(current, latest)
    expect(ids(merged)).toEqual(['1', '2', '3', '4', '5'])
    expect(merged[3].content).toBe('A2 已更新')
  })

  it('保留「加载更多」拉到的更早历史', () => {
    const current = [msg('1', 'user', 'U0'), msg('2', 'assistant', 'A0'), msg('3', 'user', 'U1'), msg('4', 'assistant', 'A1')]
    const latest = [msg('3', 'user', 'U1'), msg('4', 'assistant', 'A1 已更新')]
    expect(ids(mergeLatestPage(current, latest))).toEqual(['1', '2', '3', '4'])
  })

  it('latest 为空不清空已有内容', () => {
    const current = [msg('1', 'user', 'U1')]
    expect(mergeLatestPage(current, [])).toBe(current)
  })

  it('current 为空直接采用 latest', () => {
    const latest = [msg('5', 'user', 'U3')]
    expect(mergeLatestPage([], latest)).toBe(latest)
  })

  it('非数字 id（旧载荷/乐观消息）只追加去重，不删已有内容', () => {
    const current = [msg('temp-1', 'user', 'local'), msg('temp-2', 'assistant', 'local')]
    const latest = [msg('temp-1', 'user', 'local'), msg('temp-3', 'assistant', 'server')]
    expect(ids(mergeLatestPage(current, latest))).toEqual(['temp-1', 'temp-2', 'temp-3'])
  })
})
