import { describe, expect, it } from 'vitest'
import { isActiveSessionPhase } from './sessionPhase'

describe('isActiveSessionPhase', () => {
  it('RUNNING / RESUMING / WAITING_APPROVAL 视为执行中', () => {
    expect(isActiveSessionPhase('RUNNING')).toBe(true)
    expect(isActiveSessionPhase('RESUMING')).toBe(true)
    expect(isActiveSessionPhase('WAITING_APPROVAL')).toBe(true)
  })

  it('终态与瞬时中间态不算执行中', () => {
    expect(isActiveSessionPhase('COMPLETED')).toBe(false)
    expect(isActiveSessionPhase('FAILED')).toBe(false)
    expect(isActiveSessionPhase('CANCELLED')).toBe(false)
    expect(isActiveSessionPhase('CANCELLING')).toBe(false)
    expect(isActiveSessionPhase('IDLE')).toBe(false)
  })

  it('空值/未知值不算执行中', () => {
    expect(isActiveSessionPhase(null)).toBe(false)
    expect(isActiveSessionPhase(undefined)).toBe(false)
    expect(isActiveSessionPhase('')).toBe(false)
    expect(isActiveSessionPhase('SOMETHING_ELSE')).toBe(false)
  })
})
