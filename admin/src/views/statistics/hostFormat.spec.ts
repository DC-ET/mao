import { describe, expect, it } from 'vitest'
import {
  clampPercent,
  diskPlace,
  formatLoad,
  formatPercent,
  formatUptime,
  memoryHint,
  platformLabel,
  usageColor,
  usageLevel
} from './hostFormat'

describe('hostFormat', () => {
  it('平台名与开机时长', () => {
    expect(platformLabel('linux')).toBe('Linux')
    expect(platformLabel('darwin')).toBe('macOS')
    expect(platformLabel('freebsd')).toBe('freebsd')
    expect(formatUptime(45)).toBe('45 秒')
    expect(formatUptime(125)).toBe('2 分钟')
    expect(formatUptime(3 * 3600 + 5 * 60)).toBe('3 小时 5 分钟')
    expect(formatUptime(2 * 86400 + 4 * 3600)).toBe('2 天 4 小时')
    expect(formatUptime(Number.NaN)).toBe('—')
  })

  it('百分比、负载和水位', () => {
    expect(formatPercent(null)).toBe('—')
    expect(formatPercent(12)).toBe('12%')
    expect(formatPercent(12.34)).toBe('12.3%')
    expect(formatLoad(0.1, 1, Number.NaN)).toBe('0.10 / 1.00 / —')
    expect(usageLevel(74.9)).toBe('normal')
    expect(usageLevel(75)).toBe('warm')
    expect(usageLevel(90)).toBe('hot')
    expect(usageLevel(null)).toBe('normal')
    expect(usageColor(90)).toContain('danger')
    expect(usageColor(80)).toContain('warning')
    expect(usageColor(10)).toContain('primary')
    expect(clampPercent(120)).toBe(100)
    expect(clampPercent(-3)).toBe(0)
  })

  it('内存口径与磁盘位置', () => {
    expect(memoryHint('proc')).toBe('可用含可回收缓存')
    expect(memoryHint('os')).toBe('未计入可回收缓存，占用率会偏高')
    expect(diskPlace({ path: '/', mount: '/' })).toBe('/')
    expect(diskPlace({ path: '/opt/mao-data/workspace', mount: '/opt/mao-data' }))
      .toBe('/opt/mao-data/workspace · 挂载 /opt/mao-data')
  })
})
