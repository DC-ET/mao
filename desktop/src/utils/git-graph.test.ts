import { describe, expect, it } from 'vitest'
import type { GitLogEntry } from '../types/git'
import {
  GRAPH_MAX_LANES,
  computeGitGraph,
  hiddenLaneCount,
  parseMergeTitle,
  visibleLane,
} from './git-graph'

function c(hash: string, ...parents: string[]): GitLogEntry {
  return { hash, shortHash: hash, title: hash, author: 'T', date: '2026-11-24T10:00:00+08:00', parents }
}

describe('computeGitGraph', () => {
  it('线性历史只占一列，根提交不再向下画线', () => {
    const { rows, laneCount } = computeGitGraph([c('c', 'b'), c('b', 'a'), c('a')])
    expect(laneCount).toBe(1)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    expect(rows[0].top).toEqual([])
    expect(rows[0].bottom).toEqual([{ from: 0, to: 0, color: rows[0].color }])
    expect(rows[1].top).toEqual([{ from: 0, to: 0, color: rows[0].color }])
    expect(rows[2].bottom).toEqual([])
    expect(rows[2].passLanes).toEqual([])
    expect(new Set(rows.map((r) => r.color)).size).toBe(1)
  })

  it('分叉 + 合并占两列，合并后释放第二列', () => {
    // m 合并 main(b) 与 feature(f)；f、b 都基于 a
    const { rows, laneCount } = computeGitGraph([c('m', 'b', 'f'), c('f', 'a'), c('b', 'a'), c('a')])
    expect(laneCount).toBe(2)
    const [m, f, b, a] = rows
    expect(m.isMerge).toBe(true)
    expect(m.lane).toBe(0)
    expect(m.bottom).toEqual([
      { from: 0, to: 0, color: m.color },
      { from: 0, to: 1, color: f.color },
    ])
    expect(f.lane).toBe(1)
    expect(f.color).not.toBe(m.color)
    // f 的父提交 a 尚无列等待：沿用 f 自己的列
    expect(f.bottom).toContainEqual({ from: 1, to: 1, color: f.color })
    expect(b.lane).toBe(0)
    // b 的父提交 a 已在第 1 列等待：连过去，第 0 列释放
    expect(b.bottom).toContainEqual({ from: 0, to: 1, color: b.color })
    expect(b.passLanes).toEqual([{ lane: 1, color: f.color }])
    expect(a.lane).toBe(1)
    expect(a.passLanes).toEqual([])
  })

  it('两个分支末梢汇入同一提交：上半段两条线都收进圆点', () => {
    const { rows } = computeGitGraph([c('x', 'a'), c('y', 'a'), c('a')])
    expect(rows[0].lane).toBe(0)
    expect(rows[1].lane).toBe(1)
    // y 的父提交 a 已在第 0 列：y 的列不保留
    expect(rows[1].bottom).toContainEqual({ from: 1, to: 0, color: rows[1].color })
    expect(rows[2].lane).toBe(0)
    expect(rows[2].top).toEqual([{ from: 0, to: 0, color: rows[0].color }])
  })

  it('章鱼合并（3 个父提交）各分一列', () => {
    const { rows, laneCount } = computeGitGraph([c('o', 'p1', 'p2', 'p3'), c('p3', 'r'), c('p2', 'r'), c('p1', 'r'), c('r')])
    expect(laneCount).toBe(3)
    expect(rows[0].bottom.map((s) => s.to)).toEqual([0, 1, 2])
    expect(rows[1].lane).toBe(2)
    expect(rows[2].lane).toBe(1)
    expect(rows[4].lane).toBe(2)
  })

  it('父提交未加载时线一直延伸到最后一行', () => {
    const { rows } = computeGitGraph([c('b', 'a'), c('side', 'zzz'), c('a', 'older')])
    expect(rows[1].lane).toBe(1)
    expect(rows[2].bottom).toContainEqual({ from: 1, to: 1, color: rows[1].color })
    expect(rows[2].passLanes.map((p) => p.lane)).toEqual([0, 1])
  })

  it('释放的列被后来的分支复用，不向右无限增长', () => {
    const { rows, laneCount } = computeGitGraph([
      c('m2', 'm1', 'f2'),
      c('f2', 'm0'),
      c('m1', 'm0', 'f1'),
      c('f1', 'm0'),
      c('m0'),
    ])
    expect(rows[1].lane).toBe(1)
    // m1 的首父 m0 已在第 1 列等待：第 0 列空出，第二父 f1 复用它
    expect(rows[2].bottom).toContainEqual({ from: 0, to: 1, color: rows[2].color })
    expect(rows[3].lane).toBe(0)
    expect(laneCount).toBe(2)

    const reuse = computeGitGraph([c('a', 'base'), c('b', 'base'), c('base', 'root'), c('n', 'root'), c('root')])
    expect(reuse.rows[3].lane).toBe(1)
    expect(reuse.laneCount).toBe(2)
  })

  it('缺 parents 字段（旧后端）时每行孤立成点而不崩', () => {
    const legacy = [{ hash: 'a', shortHash: 'a', title: 'a', author: 'T', date: '' }] as unknown as GitLogEntry[]
    const { rows } = computeGitGraph(legacy)
    expect(rows[0]).toMatchObject({ lane: 0, top: [], bottom: [], passLanes: [] })
  })

  it('超出可见上限的列钳到最后一列并计数', () => {
    const n = GRAPH_MAX_LANES + 2
    const tips = Array.from({ length: n }, (_, i) => c(`t${i}`, `p${i}`))
    const mids = Array.from({ length: n }, (_, i) => c(`p${i}`, 'base'))
    const { rows, laneCount } = computeGitGraph([...tips, ...mids, c('base')])
    expect(laneCount).toBe(GRAPH_MAX_LANES + 2)
    const last = rows[GRAPH_MAX_LANES + 1]
    expect(last.lane).toBe(GRAPH_MAX_LANES + 1)
    expect(visibleLane(last.lane)).toBe(GRAPH_MAX_LANES - 1)
    expect(hiddenLaneCount(last)).toBe(2)
    expect(hiddenLaneCount(rows[0])).toBe(0)
  })
})

describe('parseMergeTitle', () => {
  it.each([
    ["Merge branch 'feature/x' into 'release_prod_1'", 'feature/x → release_prod_1'],
    ["Merge branch 'release_prod_1' into 'master'", 'release_prod_1 → master'],
    ["Merge branch 'dev' into main", 'dev → main'],
    ["Merge branch 'dev' of https://git.example.com/a/b into main", 'dev → main'],
    ["Merge branch 'dev'", 'dev → (当前)'],
    ["Merge remote-tracking branch 'origin/main'", 'origin/main → (当前)'],
    ["Merge remote-tracking branch 'origin/main' into feature", 'origin/main → feature'],
    ['Merge pull request #42 from someone/fix-bug', '#42 someone/fix-bug'],
  ])('%s', (title, expected) => {
    expect(parseMergeTitle(title)).toBe(expected)
  })

  it('不认识的格式返回 null', () => {
    expect(parseMergeTitle('Merge stuff manually')).toBeNull()
    expect(parseMergeTitle('feat: merge branch support')).toBeNull()
    expect(parseMergeTitle('')).toBeNull()
  })
})
