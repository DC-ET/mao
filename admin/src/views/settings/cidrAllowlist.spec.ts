import { describe, expect, it } from 'vitest'
import { cidrAllowlistError, isValidCidr } from './cidrAllowlist'

describe('isValidCidr', () => {
  it('接受合法 IPv4 与带前缀写法', () => {
    expect(isValidCidr('10.0.0.0/8')).toBe(true)
    expect(isValidCidr('192.168.1.0/24')).toBe(true)
    expect(isValidCidr('172.16.0.1')).toBe(true)
    expect(isValidCidr('0.0.0.0/0')).toBe(true)
    expect(isValidCidr(' 10.0.0.0/8 ')).toBe(true)
  })

  it('拒绝越界八位组与超范围前缀', () => {
    expect(isValidCidr('256.0.0.1')).toBe(false)
    expect(isValidCidr('10.0.0.0/33')).toBe(false)
    expect(isValidCidr('10.0.0.0/')).toBe(false)
    expect(isValidCidr('10.0.0')).toBe(false)
    expect(isValidCidr('example.com')).toBe(false)
    expect(isValidCidr('10.0.0.0/8/16')).toBe(false)
  })
})

describe('cidrAllowlistError', () => {
  it('空串合法（一律按私网拒绝）', () => {
    expect(cidrAllowlistError('')).toBe('')
    expect(cidrAllowlistError('   ')).toBe('')
    expect(cidrAllowlistError(undefined)).toBe('')
    expect(cidrAllowlistError(null)).toBe('')
  })

  it('接受空数组与合法 CIDR 数组', () => {
    expect(cidrAllowlistError('[]')).toBe('')
    expect(cidrAllowlistError('["10.0.0.0/8","192.168.1.0/24"]')).toBe('')
  })

  it('非 JSON 给出解析提示', () => {
    expect(cidrAllowlistError('10.0.0.0/8')).toBe('需为 JSON 数组，如 ["10.0.0.0/8"]')
  })

  it('非数组给出数组提示', () => {
    expect(cidrAllowlistError('{"a":1}')).toBe('需为 CIDR JSON 数组，如 ["10.0.0.0/8","192.168.1.0/24"]')
  })

  it('数组内含非字符串或非法 CIDR 时指出问题项', () => {
    expect(cidrAllowlistError('["10.0.0.0/8", 42]')).toContain('存在无效 CIDR：42')
    expect(cidrAllowlistError('["not-a-cidr"]')).toContain('存在无效 CIDR：not-a-cidr')
    expect(cidrAllowlistError('["10.0.0.0/33"]')).toContain('存在无效 CIDR：10.0.0.0/33')
  })

  it('超长问题项截断到 32 字符', () => {
    const long = 'x'.repeat(80)
    expect(cidrAllowlistError(JSON.stringify([long]))).toContain('x'.repeat(32))
    expect(cidrAllowlistError(JSON.stringify([long]))).not.toContain('x'.repeat(33))
  })

  it('拒绝与环回 / 云元数据相交的 CIDR（后端同款硬拒）', () => {
    expect(cidrAllowlistError('["127.0.0.0/8"]')).toContain('不允许放行环回')
    expect(cidrAllowlistError('["127.0.0.1"]')).toContain('不允许放行环回')
    expect(cidrAllowlistError('["169.254.169.254"]')).toContain('不允许放行环回')
    expect(cidrAllowlistError('["169.254.0.0/16"]')).toContain('不允许放行环回')
    expect(cidrAllowlistError('["0.0.0.0/0"]')).toContain('不允许放行环回')
    expect(cidrAllowlistError('["10.0.0.0/8","169.254.0.0/16"]')).toContain('169.254.0.0/16')
  })

  it('接受不与硬拒网段相交的 CIDR', () => {
    expect(cidrAllowlistError('["10.0.0.0/8"]')).toBe('')
    expect(cidrAllowlistError('["172.16.0.0/12","192.168.1.0/24"]')).toBe('')
    expect(cidrAllowlistError('["169.253.0.0/16"]')).toBe('')
  })
})
