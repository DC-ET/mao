import { describe, expect, it } from 'vitest'
import { appendHostTrend, HOST_TREND_WINDOW_MS, hostTrendOption, type HostTrendPoint } from './hostTrend'

describe('hostTrend', () => {
  it('并入新点并丢掉 5 分钟以前的', () => {
    const start = 1_700_000_000_000
    const old: HostTrendPoint = { at: start - 1, cpu: 10, memory: 20 }
    const kept: HostTrendPoint = { at: start, cpu: 30, memory: 40 }
    const next = appendHostTrend([old, kept], { at: start + HOST_TREND_WINDOW_MS, cpu: null, memory: 50 })
    expect(next.map((point) => point.cpu)).toEqual([30, null])
    expect(next.map((point) => point.memory)).toEqual([40, 50])
  })

  it('同一时刻后来的覆盖先前的', () => {
    const at = 1_700_000_000_000
    const next = appendHostTrend([{ at, cpu: 1, memory: 2 }], { at, cpu: 9, memory: 8 })
    expect(next).toEqual([{ at, cpu: 9, memory: 8 }])
  })

  it('CPU 和内存各一张图，CPU 空值保持断开', () => {
    const points = [
      { at: 1_700_000_000_000, cpu: null, memory: 40 },
      { at: 1_700_000_001_000, cpu: 12, memory: 41 }
    ]
    const cpu = hostTrendOption(points, 'cpu')
    const memory = hostTrendOption(points, 'memory')
    const cpuSeries = cpu.series as Array<{ name: string; data: Array<[number, number | null]> }>
    const memorySeries = memory.series as Array<{ name: string; data: Array<[number, number | null]> }>
    expect(cpuSeries).toHaveLength(1)
    expect(memorySeries).toHaveLength(1)
    expect(cpuSeries[0]).toMatchObject({ name: 'CPU', data: [[1_700_000_000_000, null], [1_700_000_001_000, 12]] })
    expect(memorySeries[0]).toMatchObject({ name: '内存', data: [[1_700_000_000_000, 40], [1_700_000_001_000, 41]] })
    expect(cpu.yAxis).toMatchObject({ min: 0, max: 100 })
    expect(memory.yAxis).toMatchObject({ min: 0, max: 100 })
  })
})