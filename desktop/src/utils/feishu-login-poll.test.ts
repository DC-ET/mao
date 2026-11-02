import { describe, expect, it } from 'vitest'
import { feishuPollPhase } from './feishu-login-poll'

describe('feishuPollPhase', () => {
  it('换票中的 PROCESSING 继续轮询', () => {
    expect(feishuPollPhase('PROCESSING')).toBe('processing')
    expect(feishuPollPhase('PENDING')).toBe('pending')
    expect(feishuPollPhase(undefined)).toBe('pending')
  })

  it('只有成功、失败、过期才结束', () => {
    expect(feishuPollPhase('SUCCESS')).toBe('success')
    expect(feishuPollPhase('FAILED')).toBe('failure')
    expect(feishuPollPhase('EXPIRED')).toBe('failure')
  })
})
