import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../types/chat'
import {
  NOTICE_COLLAPSE_CHARS,
  NOTICE_EXCERPT_CHARS,
  getBackgroundCompletion,
  isBackgroundNoticeFailed,
  isNoticeLong,
  noticeExcerpt
} from './backgroundNotice'

function noticeMessage(content: string, status = 'COMPLETED'): ChatMessage {
  return {
    id: '1',
    role: 'assistant',
    content,
    createdAt: '2026-09-29 10:00:00',
    metadata: {
      backgroundSubagentCompletion: {
        childSessionId: 42,
        executionId: 7,
        status,
        agentType: 'reviewer'
      }
    }
  }
}

describe('getBackgroundCompletion', () => {
  it('读出后台子代理完成通知的 metadata', () => {
    const meta = getBackgroundCompletion(noticeMessage('后台子代理（reviewer）已完成：ok'))
    expect(meta?.childSessionId).toBe(42)
    expect(meta?.status).toBe('COMPLETED')
    expect(meta?.agentType).toBe('reviewer')
  })

  it('普通消息没有通知 metadata', () => {
    expect(getBackgroundCompletion({
      id: '2', role: 'assistant', content: 'hi', createdAt: '2026-09-29 10:00:00'
    })).toBeNull()
    expect(getBackgroundCompletion({
      id: '3', role: 'user', content: 'hi', createdAt: '2026-09-29 10:00:00', metadata: {}
    })).toBeNull()
    // metadata 损坏（非对象）不当成通知
    expect(getBackgroundCompletion({
      id: '4', role: 'assistant', content: 'hi', createdAt: '2026-09-29 10:00:00',
      metadata: { backgroundSubagentCompletion: 'oops' }
    })).toBeNull()
  })
})

describe('isBackgroundNoticeFailed', () => {
  it('失败/取消需要展示原因摘要', () => {
    expect(isBackgroundNoticeFailed('FAILED')).toBe(true)
    expect(isBackgroundNoticeFailed('CANCELLED')).toBe(true)
  })

  it('完成与未知状态不展示摘要', () => {
    expect(isBackgroundNoticeFailed('COMPLETED')).toBe(false)
    expect(isBackgroundNoticeFailed(undefined)).toBe(false)
    expect(isBackgroundNoticeFailed('RUNNING')).toBe(false)
  })
})

describe('isNoticeLong', () => {
  it('超过折叠阈值才算长', () => {
    expect(isNoticeLong('x'.repeat(NOTICE_COLLAPSE_CHARS))).toBe(false)
    expect(isNoticeLong('x'.repeat(NOTICE_COLLAPSE_CHARS + 1))).toBe(true)
  })

  it('空内容不算长', () => {
    expect(isNoticeLong(undefined)).toBe(false)
    expect(isNoticeLong('')).toBe(false)
  })
})

describe('noticeExcerpt', () => {
  it('短内容原样返回（仅压平空白）', () => {
    expect(noticeExcerpt('  后台子代理（reviewer）执行失败：boom  ')).toBe('后台子代理（reviewer）执行失败：boom')
  })

  it('多行内容压成一行', () => {
    expect(noticeExcerpt('第一行\n第二行\t制表')).toBe('第一行 第二行 制表')
  })

  it('长内容截断并加省略号', () => {
    const excerpt = noticeExcerpt('x'.repeat(500))
    expect(excerpt).toHaveLength(NOTICE_EXCERPT_CHARS + 1)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('空内容返回空串', () => {
    expect(noticeExcerpt(undefined)).toBe('')
    expect(noticeExcerpt('   ')).toBe('')
  })
})
