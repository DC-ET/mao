import { describe, expect, it } from 'vitest'
import { sessionTypeTag } from './labels'

describe('sessionTypeTag', () => {
  it('labels main sessions instead of leaving the column blank', () => {
    expect(sessionTypeTag('NORMAL')).toEqual({ label: '主会话', type: 'info' })
    expect(sessionTypeTag(null)).toEqual({ label: '主会话', type: 'info' })
    expect(sessionTypeTag(undefined)).toEqual({ label: '主会话', type: 'info' })
  })

  it('distinguishes side tasks from subagents', () => {
    expect(sessionTypeTag('SIDE_TASK')).toEqual({ label: '边路任务', type: 'warning' })
    expect(sessionTypeTag('SUBAGENT')).toEqual({ label: '子代理', type: 'info' })
  })

  it('shows unknown codes as-is rather than swallowing them', () => {
    expect(sessionTypeTag('LEGACY')).toEqual({ label: 'LEGACY', type: 'info' })
  })
})
