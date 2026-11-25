import { describe, expect, it } from 'vitest'
import {
  QUEUE_DISPLAY_BUDGET,
  nextQueueGroup,
  readInboundQueueSnapshot,
  shouldShowQueueBlocked,
  truncateQueueSegments,
  visibleQueueCount,
} from './queue-view'

describe('visibleQueueCount', () => {
  it('sums both groups and never goes negative', () => {
    expect(visibleQueueCount(2, 1)).toBe(3)
    expect(visibleQueueCount(0, 1)).toBe(1)
    expect(visibleQueueCount(-1, 2)).toBe(2)
    expect(visibleQueueCount(0, 0)).toBe(0)
  })
})

describe('nextQueueGroup', () => {
  it('returns the only non-empty group', () => {
    expect(nextQueueGroup(0, 2, null)).toBe('feishu')
    expect(nextQueueGroup(3, 0, null)).toBe('local')
  })

  it('follows the running channel when both groups have items', () => {
    expect(nextQueueGroup(1, 1, 'feishu')).toBe('feishu')
    expect(nextQueueGroup(1, 1, 'local')).toBe('local')
  })

  it('does not guess an order when nothing is running', () => {
    expect(nextQueueGroup(1, 1, null)).toBeNull()
  })

  it('returns null when both queues are empty', () => {
    expect(nextQueueGroup(0, 0, 'feishu')).toBeNull()
  })
})

describe('shouldShowQueueBlocked', () => {
  it('requires both a failed last run and pending items', () => {
    expect(shouldShowQueueBlocked(true, 1)).toBe(true)
    expect(shouldShowQueueBlocked(true, 0)).toBe(false)
    expect(shouldShowQueueBlocked(false, 2)).toBe(false)
  })
})

describe('truncateQueueSegments', () => {
  it('keeps short text intact', () => {
    const { segments, truncated } = truncateQueueSegments('发布生产环境')
    expect(truncated).toBe(false)
    expect(segments).toEqual([{ type: 'text', content: '发布生产环境' }])
  })

  it('truncates beyond the display budget', () => {
    const long = 'x'.repeat(QUEUE_DISPLAY_BUDGET + 10)
    const { segments, truncated } = truncateQueueSegments(long)
    expect(truncated).toBe(true)
    const text = segments.map((seg) => (seg.type === 'text' ? seg.content : '')).join('')
    expect(text).toHaveLength(QUEUE_DISPLAY_BUDGET)
  })

  it('handles empty content without throwing', () => {
    const { segments, truncated } = truncateQueueSegments('')
    // splitUserMessageForDisplay('') 会返回一个空文本段；只要不抛错且未标记截断即可。
    expect(segments.every((seg) => seg.type === 'text' && seg.content === '')).toBe(true)
    expect(truncated).toBe(false)
  })
})

describe('readInboundQueueSnapshot', () => {
  it('maps a well-formed payload', () => {
    expect(readInboundQueueSnapshot({
      items: [{ id: 7, summary: '发布生产', senderLabel: '张三' }],
      runningChannel: 'feishu',
      lastRunFailed: true,
    })).toEqual({
      items: [{ id: 7, summary: '发布生产', senderLabel: '张三' }],
      runningChannel: 'feishu',
      lastRunFailed: true,
    })
  })

  it('falls back to an empty snapshot for missing/garbage payloads', () => {
    const empty = { items: [], runningChannel: null, lastRunFailed: false }
    expect(readInboundQueueSnapshot(undefined)).toEqual(empty)
    expect(readInboundQueueSnapshot(null)).toEqual(empty)
    // 端点异常返回对象（如统一 Result 外壳）时不该把非数组灌进面板
    expect(readInboundQueueSnapshot({ items: { 0: 'x' } })).toEqual(empty)
    expect(readInboundQueueSnapshot({ items: [], runningChannel: 'bogus', lastRunFailed: 'true' }))
      .toEqual(empty)
  })
})
