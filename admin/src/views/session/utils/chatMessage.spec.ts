import { describe, expect, it } from 'vitest'
import { extractToolPreviewFromMetadata, mapApiMessagesToChat } from './chatMessage'

describe('extractToolPreviewFromMetadata', () => {
  it('keeps inline base64 for legacy / export payloads', () => {
    const preview = extractToolPreviewFromMetadata(JSON.stringify({
      attachments: [{ mime: 'image/png', path: 'a.png', data_uri: 'data:image/png;base64,AAA' }]
    }))
    expect(preview).toMatchObject({ media_type: 'image', mime: 'image/png', data_uri: 'data:image/png;base64,AAA' })
    expect(preview?.attachmentIndex).toBeUndefined()
  })

  it('compact 载荷只留附件定位信息，不返回 base64', () => {
    const preview = extractToolPreviewFromMetadata(JSON.stringify({
      attachments: [{ mime: 'image/png', path: 'bw-check7.png' }]
    }))
    expect(preview).toEqual({
      media_type: 'image',
      mime: 'image/png',
      path: 'bw-check7.png',
      attachmentIndex: 0
    })
  })

  it('没有 attachments / 非法 JSON 时返回 undefined', () => {
    expect(extractToolPreviewFromMetadata(null)).toBeUndefined()
    expect(extractToolPreviewFromMetadata('not-json')).toBeUndefined()
    expect(extractToolPreviewFromMetadata(JSON.stringify({ attachments: [] }))).toBeUndefined()
  })
})

describe('mapApiMessagesToChat 附件定位', () => {
  const assistant = {
    id: 1,
    role: 'ASSISTANT',
    content: '',
    toolCalls: JSON.stringify([{ id: 'call-1', type: 'function', function: { name: 'page_screenshot', arguments: '{}' } }]),
    createdAt: '2026-10-23 10:00:00'
  }

  it('把会话/消息 id 补到 compact 预览上，供展开时按需取图', () => {
    const messages = mapApiMessagesToChat([
      assistant,
      {
        id: 2,
        role: 'TOOL',
        toolCallId: 'call-1',
        content: '{"media_type":"image","mime":"image/png","path":"bw-check7.png"}',
        metadata: JSON.stringify({ attachments: [{ mime: 'image/png', path: 'bw-check7.png' }] }),
        createdAt: '2026-10-23 10:00:01'
      }
    ], '1396')

    expect(messages[0].toolCalls?.[0].preview).toMatchObject({
      media_type: 'image',
      attachmentIndex: 0,
      sessionId: '1396',
      messageId: '2'
    })
  })

  it('内联 base64 的旧载荷不需要附件定位', () => {
    const messages = mapApiMessagesToChat([
      assistant,
      {
        id: 2,
        role: 'TOOL',
        toolCallId: 'call-1',
        content: '{"media_type":"image","mime":"image/png"}',
        metadata: JSON.stringify({ attachments: [{ mime: 'image/png', data_uri: 'data:image/png;base64,AAA' }] }),
        createdAt: '2026-10-23 10:00:01'
      }
    ], '1396')

    expect(messages[0].toolCalls?.[0].preview?.data_uri).toBe('data:image/png;base64,AAA')
    expect(messages[0].toolCalls?.[0].preview?.sessionId).toBeUndefined()
  })
})
