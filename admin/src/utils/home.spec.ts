import { describe, expect, it } from 'vitest'
import { pickHomePath } from './home'

const ALL = () => true
const NONE = () => false
const only = (...permissions: string[]) => (permission: string) => permissions.includes(permission)

describe('pickHomePath', () => {
  it('全权限且无隐藏项时优先用量分析', () => {
    expect(pickHomePath(ALL)).toBe('/analytics')
  })

  it('不传 isHidden 时保持原降级链（回归保护 4 个调用点的默认语义）', () => {
    expect(pickHomePath(only('session:read'))).toBe('/sessions')
    expect(pickHomePath(only('agent:read'))).toBe('/agents')
    expect(pickHomePath(only('user:read'))).toBe('/users')
    expect(pickHomePath(only('settings:read'))).toBe('/settings')
    expect(pickHomePath(only('model:read'))).toBe('/models')
    expect(pickHomePath(NONE)).toBe('/forbidden')
  })

  it('隐藏的页面被降级链跳过', () => {
    expect(pickHomePath(ALL, (index) => index === '/analytics')).toBe('/sessions')
  })

  it('连续隐藏多项时落到下一个可见有权限页', () => {
    const hidden = new Set(['/analytics', '/sessions'])
    expect(pickHomePath(ALL, (index) => hidden.has(index))).toBe('/agents')
  })

  it('全部候选页都被隐藏时落到 /forbidden', () => {
    const hidden = new Set(['/analytics', '/sessions', '/agents', '/users', '/settings', '/models'])
    expect(pickHomePath(ALL, (index) => hidden.has(index))).toBe('/forbidden')
  })

  it('权限与隐藏同时生效：只隐藏唯一有权限的页面时落到 /forbidden', () => {
    expect(pickHomePath(only('session:read'), (index) => index === '/sessions')).toBe('/forbidden')
  })
})
