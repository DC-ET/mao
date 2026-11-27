import { describe, expect, it } from 'vitest'
import type { ReplayFrameMeta } from '@mao/contracts'
import {
  frameUrlFor,
  httpStatusOf,
  replayAdvanceIndex,
  replayBars,
  replayClock,
  replayIndexForRatio
} from './replayPlayer'

// 用例自 desktop/src/utils/replayPlayer.test.ts 移植（同源实现，勿只改一端）；
// 另补管理端新增的帧端点路径 / HTTP 404 判定用例。

function framesOf(...ts: number[]): ReplayFrameMeta[] {
  return ts.map((ts, i) => ({ seq: i + 1, ts, pageUrl: 'https://e.com/a', width: 640, height: 480, bytes: 1, file: `f${i + 1}.jpg` }))
}

describe('replayBars（时间轴密度带几何）', () => {
  it('均匀间隔 → x 线性分布、不透明度恒 1', () => {
    const bars = replayBars(framesOf(0, 1000, 2000, 3000))
    expect(bars).toHaveLength(4)
    expect(bars[0].x).toBe(0)
    expect(bars[3].opacity).toBe(1)
    expect(bars.every((b) => b.h === 26)).toBe(true)
  })

  it('静止长间隔 → 对数映射稀疏（不透明度低但不为 0）；密集段浓', () => {
    const bars = replayBars(framesOf(0, 1000, 60_000, 61_000))
    expect(bars[1].opacity).toBeLessThan(1) // 1s → 59s 静止
    expect(bars[2].opacity).toBe(1) // 密集
    expect(bars[1].opacity).toBeGreaterThanOrEqual(0.15)
    expect(bars[1].x).toBeGreaterThan(bars[0].x)
  })

  it('空帧 / 单帧安全', () => {
    expect(replayBars([])).toEqual([])
    expect(replayBars(framesOf(0))).toHaveLength(1)
  })
})

describe('replayIndexForRatio（点击/拖拽定位）', () => {
  const frames = framesOf(0, 10_000, 20_000)
  it('比例 0 / 1 钳制到两端帧', () => {
    expect(replayIndexForRatio(frames, 0)).toBe(0)
    expect(replayIndexForRatio(frames, 1)).toBe(2)
    expect(replayIndexForRatio(frames, -5)).toBe(0)
  })
  it('命中 ts <= 目标时间的最后一帧', () => {
    expect(replayIndexForRatio(frames, 0.6)).toBe(1) // 12000ms → 帧 2 (ts 10000)
    expect(replayIndexForRatio(frames, 0.45)).toBe(0) // 9000ms → 帧 1（帧 2 ts 10000 > 9000）
    expect(replayIndexForRatio(frames, 0.4)).toBe(0)
  })
  it('空帧返回 -1', () => {
    expect(replayIndexForRatio([], 0.5)).toBe(-1)
  })
})

describe('replayAdvanceIndex（播放头单调推进）', () => {
  const frames = framesOf(0, 1000, 2000, 3000)
  it('推进到 ts <= playhead 的最后一帧', () => {
    expect(replayAdvanceIndex(frames, 0, 1500)).toBe(1)
    expect(replayAdvanceIndex(frames, 1, 2500)).toBe(2)
    expect(replayAdvanceIndex(frames, 0, 999)).toBe(0)
  })
  it('fromIdx 越界钳制；不回退', () => {
    expect(replayAdvanceIndex(frames, 99, 0)).toBe(3)
    expect(replayAdvanceIndex(frames, 2, 500)).toBe(2)
  })
  it('空帧返回 -1', () => {
    expect(replayAdvanceIndex([], 0, 1000)).toBe(-1)
  })
})

describe('replayClock', () => {
  it('mm:ss 格式，负值钳 0', () => {
    expect(replayClock(0)).toBe('00:00')
    expect(replayClock(65_000)).toBe('01:05')
    expect(replayClock(-5)).toBe('00:00')
  })
})

describe('frameUrlFor（管理端帧端点路径）', () => {
  it('拼 admin 命名空间路径', () => {
    expect(frameUrlFor(12, 'L1732700000000', 3)).toBe('/admin/browser-replays/12/L1732700000000/frames/3')
  })
  it('liveId 非常规字符时编码，避免拼出越权路径', () => {
    expect(frameUrlFor(1, 'L1/../x', 1)).toBe('/admin/browser-replays/1/L1%2F..%2Fx/frames/1')
  })
})

describe('httpStatusOf（后端 404 是空 body，按 HTTP 状态判定）', () => {
  it('取 response.status', () => {
    expect(httpStatusOf({ response: { status: 404 } })).toBe(404)
    expect(httpStatusOf({ response: { status: 500 } })).toBe(500)
  })
  it('无 response / 非数字状态返回 0', () => {
    expect(httpStatusOf(new Error('network'))).toBe(0)
    expect(httpStatusOf({})).toBe(0)
    expect(httpStatusOf({ response: { status: 'x' } })).toBe(0)
    expect(httpStatusOf(undefined)).toBe(0)
  })
})
