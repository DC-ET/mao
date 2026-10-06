import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { api } from '../api'
import { useForkPreview } from './useForkPreview'

vi.mock('../api', () => ({ api: { get: vi.fn() } }))

function messageVo(id: number, role: string, content: string) {
  return { id, sessionId: 1, role, content, createdAt: '2026-10-06 18:00:00', updatedAt: '2026-10-06 18:00:00' }
}

function page(ids: number[], hasMore: boolean, nextBeforeMessageId: number | null) {
  return {
    data: {
      messages: ids.map(id => messageVo(id, id % 2 === 0 ? 'ASSISTANT' : 'USER', `m${id}`)),
      hasMore,
      nextBeforeMessageId,
      compactionEvents: [],
    },
  }
}

describe('useForkPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('选中 Fork 且来源会话可用时才拉预览', async () => {
    const contextMode = ref<'none' | 'summary' | 'fork'>('none')
    useForkPreview({
      sourceSessionId: ref('1'),
      contextMode,
      forkFromMessageId: ref(null),
      hasRealSession: ref(false),
    })
    await nextTick()
    expect(api.get).not.toHaveBeenCalled()

    contextMode.value = 'fork'
    await nextTick()
    expect(api.get).toHaveBeenCalledWith('/sessions/1/fork-preview', {
      params: { roundLimit: 5 },
    })
  })

  it('没有来源会话时不发请求，不留下上一批预览', async () => {
    const contextMode = ref<'none' | 'summary' | 'fork'>('fork')
    const preview = useForkPreview({
      sourceSessionId: ref(''),
      contextMode,
      forkFromMessageId: ref(null),
      hasRealSession: ref(false),
    })
    await nextTick()
    expect(api.get).not.toHaveBeenCalled()
    expect(preview.messages.value).toEqual([])
  })

  it('切点变化按新切点重新拉取，旧响应不覆盖新状态', async () => {
    const forkFromMessageId = ref<number | null>(null)
    vi.mocked(api.get)
      .mockResolvedValueOnce(page([2], true, 1) as never)
      .mockResolvedValueOnce(page([1], false, null) as never)
    const preview = useForkPreview({
      sourceSessionId: ref('1'),
      contextMode: ref<'none' | 'summary' | 'fork'>('fork'),
      forkFromMessageId,
      hasRealSession: ref(false),
    })
    await nextTick()
    await nextTick()
    expect(preview.messages.value.map(m => m.id)).toEqual(['2'])

    forkFromMessageId.value = 7
    await nextTick()
    await nextTick()
    expect(api.get).toHaveBeenLastCalledWith('/sessions/1/fork-preview', {
      params: { roundLimit: 5, forkFromMessageId: 7 },
    })
    expect(preview.messages.value.map(m => m.id)).toEqual(['1'])
  })

  it('翻页把更早的轮次插到前面并推进游标', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(page([4, 3], true, 3) as never)
      .mockResolvedValueOnce(page([2, 1], false, null) as never)
    const preview = useForkPreview({
      sourceSessionId: ref('1'),
      contextMode: ref<'none' | 'summary' | 'fork'>('fork'),
      forkFromMessageId: ref(4),
      hasRealSession: ref(false),
    })
    await nextTick()
    await nextTick()
    expect(preview.messages.value.map(m => m.id)).toEqual(['4', '3'])
    expect(preview.hasMore.value).toBe(true)

    const loaded = await preview.loadOlder()
    expect(loaded).toBe(true)
    expect(api.get).toHaveBeenLastCalledWith('/sessions/1/fork-preview', {
      params: { roundLimit: 5, beforeMessageId: 3, forkFromMessageId: 4 },
    })
    expect(preview.messages.value.map(m => m.id)).toEqual(['2', '1', '4', '3'])
    expect(preview.hasMore.value).toBe(false)
  })

  it('请求失败不抛错，只回到空预览（发送链路不受影响）', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('network') as never)
    const preview = useForkPreview({
      sourceSessionId: ref('1'),
      contextMode: ref<'none' | 'summary' | 'fork'>('fork'),
      forkFromMessageId: ref(null),
      hasRealSession: ref(false),
    })
    await nextTick()
    await nextTick()
    expect(preview.messages.value).toEqual([])
    expect(preview.loading.value).toBe(false)
  })

  it('切回不继承 / 会话转正时清空预览，避免旧历史残留', async () => {
    vi.mocked(api.get).mockResolvedValue(page([2, 1], false, null) as never)
    const contextMode = ref<'none' | 'summary' | 'fork'>('fork')
    const hasRealSession = ref(false)
    const preview = useForkPreview({
      sourceSessionId: ref('1'),
      contextMode,
      forkFromMessageId: ref(null),
      hasRealSession,
    })
    await nextTick()
    await nextTick()
    expect(preview.messages.value).toHaveLength(2)

    contextMode.value = 'none'
    await nextTick()
    expect(preview.messages.value).toEqual([])

    contextMode.value = 'fork'
    await nextTick()
    await nextTick()
    expect(preview.messages.value).toHaveLength(2)
    // 会话转正：真实消息改由 REST 拉取，预览立刻让位
    hasRealSession.value = true
    await nextTick()
    expect(preview.messages.value).toEqual([])
    expect(api.get).toHaveBeenCalledTimes(2)
  })
})
