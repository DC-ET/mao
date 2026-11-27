// 设置页「浏览器回放」列表纯逻辑单测（技术方案 2026-11-27 §9）：时间范围档位 → 时间窗 /
// 请求参数（Asia/Shanghai 日历口径）、CLOUD + LOCAL 合并去重排序、模式/关键词筛选、分页、
// initialLiveId 匹配、LOCAL 标题补齐回落与展示格式化、批量补齐并发上限、LOCAL 行归属探测（403 剔行）。
import { describe, expect, it } from 'vitest'
import type { BrowserReplayListItem } from '@mao/contracts'
import {
  BROWSER_REPLAY_RANGE_DEFAULT,
  BROWSER_REPLAY_RANGE_OPTIONS,
  LOCAL_META_FOREIGN,
  defaultCustomRange,
  filterReplayRows,
  formatReplayBytes,
  formatReplayDuration,
  httpStatusOf,
  localMetaOutcomeFromError,
  localSessionTitleFallback,
  mapWithConcurrency,
  matchInitialReplay,
  mergeReplayRows,
  normalizeLocalSessionMeta,
  paginateReplayRows,
  replayRangeParams,
  replayRowKey,
  replayRowTitle,
  resolveReplayWindow,
  shanghaiTodayYmd,
  shiftYmd,
  type LocalReplayRow,
  type LocalSessionMeta,
} from './browserReplayList'

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function cloudRow(overrides: Partial<BrowserReplayListItem> = {}): BrowserReplayListItem {
  return {
    sessionId: 1,
    liveId: 'L1000',
    executionMode: 'CLOUD',
    sessionTitle: '云端会话',
    agentId: 7,
    agentName: '小助手',
    startedAt: 1000,
    endedAt: 2000,
    durationMs: 1000,
    frameCount: 10,
    approxBytes: 2048,
    truncated: false,
    pageUrl: 'https://cloud.example.com',
    ...overrides,
  }
}

function localRow(overrides: Partial<LocalReplayRow> = {}): LocalReplayRow {
  return {
    sessionId: 2,
    liveId: 'L5000',
    startedAt: 5000,
    endedAt: null,
    durationMs: null,
    frameCount: 5,
    approxBytes: 1024,
    truncated: true,
    pageUrl: 'https://local.example.com',
    ...overrides,
  }
}

describe('时间范围档位', () => {
  it('预设集与后端 ACTIVITY_RANGE_PRESET_DAYS 一致，默认 30D', () => {
    expect(BROWSER_REPLAY_RANGE_DEFAULT).toBe('30D')
    expect(BROWSER_REPLAY_RANGE_OPTIONS.map((o) => o.value)).toEqual(['1D', '3D', '7D', '30D', '90D', 'CUSTOM', 'ALL'])
  })

  it('shanghaiTodayYmd / shiftYmd 按上海日历日，跨月跨年正确', () => {
    expect(shanghaiTodayYmd(new Date('2026-11-27T16:30:00Z'))).toBe('2026-11-28')
    expect(shanghaiTodayYmd(new Date('2026-11-27T15:59:00Z'))).toBe('2026-11-27')
    expect(shiftYmd('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftYmd('2026-01-01', -1)).toBe('2025-12-31')
    expect(shiftYmd('2028-02-28', 1)).toBe('2028-02-29')
  })

  it('defaultCustomRange：最近 30 天（含今天）', () => {
    expect(defaultCustomRange(new Date('2026-11-27T02:00:00Z'))).toEqual(['2026-10-29', '2026-11-27'])
  })
})

describe('resolveReplayWindow', () => {
  const now = new Date('2026-11-27T16:30:00Z') // 上海 2026-11-28 00:30

  it('预设档：起于 N 天前上海 00:00，止于今天 23:59:59.999（闭区间）', () => {
    const one = resolveReplayWindow('1D', null, now)
    expect(one.from).toBe(Date.UTC(2026, 10, 28) - SHANGHAI_OFFSET_MS)
    expect(one.to).toBe(Date.UTC(2026, 10, 29) - SHANGHAI_OFFSET_MS - 1)
    const thirty = resolveReplayWindow('30D', null, now)
    expect(thirty.from).toBe(Date.UTC(2026, 9, 30) - SHANGHAI_OFFSET_MS)
    expect(thirty.to).toBe(Date.UTC(2026, 10, 29) - SHANGHAI_OFFSET_MS - 1)
  })

  it('ALL：两侧无界（本机扫描不过滤）', () => {
    expect(resolveReplayWindow('ALL', null, now)).toEqual({ from: null, to: null })
  })

  it('CUSTOM：按起止日历日，颠倒自动交换', () => {
    const win = resolveReplayWindow('CUSTOM', ['2026-11-20', '2026-11-22'], now)
    expect(win.from).toBe(Date.UTC(2026, 10, 20) - SHANGHAI_OFFSET_MS)
    expect(win.to).toBe(Date.UTC(2026, 10, 23) - SHANGHAI_OFFSET_MS - 1)
    expect(resolveReplayWindow('CUSTOM', ['2026-11-22', '2026-11-20'], now)).toEqual(win)
  })

  it('CUSTOM 日期缺失 / 非法：回落默认 30D 窗口（两端用同一窗口，CLOUD 与 LOCAL 不错位）', () => {
    const fallback = resolveReplayWindow('30D', null, now)
    expect(resolveReplayWindow('CUSTOM', null, now)).toEqual(fallback)
    expect(resolveReplayWindow('CUSTOM', ['', '2026-11-20'], now)).toEqual(fallback)
    expect(resolveReplayWindow('CUSTOM', ['2026-02-30', '2026-11-20'], now)).toEqual(fallback)
  })

  it('白名单外档位按默认档解析', () => {
    expect(resolveReplayWindow('nope', null, now)).toEqual(resolveReplayWindow('30D', null, now))
  })
})

describe('replayRangeParams', () => {
  it('预设档只发 range（窗口由后端算）', () => {
    expect(replayRangeParams('7D', null)).toEqual({ range: '7D' })
    expect(replayRangeParams('90D', null)).toEqual({ range: '90D' })
  })

  it('ALL 原样下发；白名单外回落默认档', () => {
    expect(replayRangeParams('ALL', null)).toEqual({ range: 'ALL' })
    expect(replayRangeParams('bogus', null)).toEqual({ range: BROWSER_REPLAY_RANGE_DEFAULT })
  })

  it('CUSTOM 才发日期，半成品状态回落默认档', () => {
    expect(replayRangeParams('CUSTOM', ['2026-09-08', '2026-09-12'])).toEqual({ dateFrom: '2026-09-08', dateTo: '2026-09-12' })
    expect(replayRangeParams('CUSTOM', ['', '2026-09-12'])).toEqual({ dateTo: '2026-09-12' })
    expect(replayRangeParams('CUSTOM', ['', ''])).toEqual({ range: BROWSER_REPLAY_RANGE_DEFAULT })
    expect(replayRangeParams('CUSTOM', null)).toEqual({ range: BROWSER_REPLAY_RANGE_DEFAULT })
  })
})

describe('mergeReplayRows', () => {
  it('CLOUD + LOCAL 合并，按 startedAt 倒序、同刻 liveId 倒序', () => {
    const rows = mergeReplayRows(
      [cloudRow({ sessionId: 1, liveId: 'L1000', startedAt: 1000 })],
      [localRow({ sessionId: 2, liveId: 'L5000', startedAt: 5000 }), localRow({ sessionId: 3, liveId: 'L3000', startedAt: 3000 })],
    )
    expect(rows.map((r) => r.liveId)).toEqual(['L5000', 'L3000', 'L1000'])
    expect(rows.map((r) => r.executionMode)).toEqual(['LOCAL', 'LOCAL', 'CLOUD'])
  })

  it('同刻按 liveId 数值倒序（不是字典序）', () => {
    const rows = mergeReplayRows(
      [cloudRow({ liveId: 'L900', startedAt: 1000 }), cloudRow({ liveId: 'L1000', startedAt: 1000 })],
      [],
    )
    expect(rows.map((r) => r.liveId)).toEqual(['L1000', 'L900'])
  })

  it('去重键含 executionMode：同键只留先入栈的 CLOUD 行', () => {
    const rows = mergeReplayRows(
      [
        cloudRow({ sessionId: 1, liveId: 'L1000', sessionTitle: '云端标题', startedAt: 1000 }),
        cloudRow({ sessionId: 1, liveId: 'L1000', sessionTitle: '重复行', startedAt: 1000 }),
      ],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].sessionTitle).toBe('云端标题')
    // 同一 liveId 不同 executionMode 不去重
    const both = mergeReplayRows([cloudRow({ liveId: 'L1000' })], [localRow({ liveId: 'L1000', startedAt: 1000 })])
    expect(both).toHaveLength(2)
  })

  it('LOCAL 行标题 / Agent 由 localMeta 补齐，缺失为 null', () => {
    const meta = new Map<number, LocalSessionMeta | null>([
      [2, { title: '本机会话', agentId: 9, agentName: '本地助手' }],
      [3, null],
    ])
    const rows = mergeReplayRows([], [localRow({ sessionId: 2 }), localRow({ sessionId: 3, liveId: 'L4000' })], meta)
    expect(rows.map((r) => replayRowTitle(r))).toEqual(['本机会话', '会话 #3（已删除）'])
    expect(rows[0].agentName).toBe('本地助手')
    expect(rows[1].agentId).toBeNull()
    expect(rows[1].pageUrl).toBe('https://local.example.com')
  })

  it('replayRowKey 三段拼接', () => {
    expect(replayRowKey(12, 'L1000', 'LOCAL')).toBe('12:L1000:LOCAL')
  })
})

describe('normalizeLocalSessionMeta', () => {
  it('正常会话：标题 / Agent 名 / 数字 agentId', () => {
    expect(normalizeLocalSessionMeta({ title: '会话 A', agentId: 12, agentName: '助手' }))
      .toEqual({ title: '会话 A', agentId: 12, agentName: '助手' })
  })

  it('agentId 兼容 string 形态；空标题 / 空串 Agent 归一为 null', () => {
    expect(normalizeLocalSessionMeta({ title: '  ', agentId: '34', agentName: '' }))
      .toEqual({ title: null, agentId: 34, agentName: null })
  })

  it('非对象 / null / undefined → null（取不到即回落占位标题）', () => {
    expect(normalizeLocalSessionMeta(null)).toBeNull()
    expect(normalizeLocalSessionMeta(undefined)).toBeNull()
    expect(normalizeLocalSessionMeta('oops')).toBeNull()
    expect(normalizeLocalSessionMeta(42)).toBeNull()
  })
})

describe('filterReplayRows', () => {
  const rows = mergeReplayRows(
    [
      cloudRow({ sessionId: 1, liveId: 'L1000', sessionTitle: 'Alpha 报表' }),
      cloudRow({ sessionId: 2, liveId: 'L2000', sessionTitle: 'Beta 登录' }),
    ],
    [localRow({ sessionId: 3, liveId: 'L3000' })],
    new Map([[3, { title: 'Gamma 抓取' }]]),
  )

  it('模式筛选：ALL / CLOUD / LOCAL（合并后按 startedAt 倒序）', () => {
    expect(filterReplayRows(rows, { mode: 'ALL' })).toHaveLength(3)
    expect(filterReplayRows(rows, { mode: 'CLOUD' }).map((r) => r.liveId)).toEqual(['L2000', 'L1000'])
    expect(filterReplayRows(rows, { mode: 'LOCAL' }).map((r) => r.liveId)).toEqual(['L3000'])
  })

  it('关键词：会话标题、大小写不敏感、忽略前后空白', () => {
    expect(filterReplayRows(rows, { keyword: '  beta ' }).map((r) => r.liveId)).toEqual(['L2000'])
    expect(filterReplayRows(rows, { keyword: 'GAMMA' }).map((r) => r.liveId)).toEqual(['L3000'])
    expect(filterReplayRows(rows, { keyword: '不存在' })).toHaveLength(0)
    expect(filterReplayRows(rows, { keyword: '' })).toHaveLength(3)
  })

  it('模式 + 关键词同时生效', () => {
    expect(filterReplayRows(rows, { mode: 'CLOUD', keyword: 'alpha' }).map((r) => r.liveId)).toEqual(['L1000'])
    expect(filterReplayRows(rows, { mode: 'LOCAL', keyword: 'alpha' })).toHaveLength(0)
  })

  it('标题为 null（已删除会话）不命中任何关键词', () => {
    const orphan = mergeReplayRows([], [localRow({ sessionId: 9, liveId: 'L9000' })])
    expect(filterReplayRows(orphan, { keyword: '会话' })).toHaveLength(0)
    expect(replayRowTitle(orphan[0])).toBe(localSessionTitleFallback(9))
  })
})

describe('paginateReplayRows', () => {
  const rows = Array.from({ length: 45 }, (_, i) => i)

  it('按 20/页切分，末页不满', () => {
    expect(paginateReplayRows(rows, 1, 20)).toHaveLength(20)
    expect(paginateReplayRows(rows, 3, 20)).toHaveLength(5)
    expect(paginateReplayRows(rows, 2, 20)[0]).toBe(20)
  })

  it('越界页收敛到合法区间；非法 size 回落 20', () => {
    expect(paginateReplayRows(rows, 99, 20)).toEqual(paginateReplayRows(rows, 3, 20))
    expect(paginateReplayRows(rows, 0, 20)).toEqual(paginateReplayRows(rows, 1, 20))
    expect(paginateReplayRows(rows, -3, 20)).toEqual(paginateReplayRows(rows, 1, 20))
    expect(paginateReplayRows(rows, 1, 0)).toEqual(paginateReplayRows(rows, 1, 20))
    expect(paginateReplayRows(rows, 1, Number.NaN)).toEqual(paginateReplayRows(rows, 1, 20))
  })

  it('空列表任何页都是空', () => {
    expect(paginateReplayRows([], 1, 20)).toEqual([])
    expect(paginateReplayRows([], 5, 20)).toEqual([])
  })
})

describe('matchInitialReplay', () => {
  const summaries = [
    { liveId: 'L1000', startedAt: 1000 },
    { liveId: 'L5000', startedAt: 5000 },
  ]

  it('命中 → 返回该项（调用方 open）', () => {
    expect(matchInitialReplay(summaries, 'L5000')).toEqual({ liveId: 'L5000', startedAt: 5000 })
  })

  it('未命中 / 空值 → null（停留列表，提示已被清理）', () => {
    expect(matchInitialReplay(summaries, 'L9999')).toBeNull()
    expect(matchInitialReplay(summaries, '')).toBeNull()
    expect(matchInitialReplay(summaries, undefined)).toBeNull()
    expect(matchInitialReplay(summaries, null)).toBeNull()
    expect(matchInitialReplay([], 'L1000')).toBeNull()
  })
})

describe('展示格式化', () => {
  it('时长：未结算 / 负值 → 时长未知；秒 / 分秒', () => {
    expect(formatReplayDuration(null)).toBe('时长未知')
    expect(formatReplayDuration(undefined)).toBe('时长未知')
    expect(formatReplayDuration(-1)).toBe('时长未知')
    expect(formatReplayDuration(Number.NaN)).toBe('时长未知')
    expect(formatReplayDuration(0)).toBe('0 秒')
    expect(formatReplayDuration(45_000)).toBe('45 秒')
    expect(formatReplayDuration(90_000)).toBe('1 分 30 秒')
    expect(formatReplayDuration(3_600_000)).toBe('60 分 0 秒')
  })

  it('体积：B / KB / MB', () => {
    expect(formatReplayBytes(0)).toBe('0 B')
    expect(formatReplayBytes(1023)).toBe('1023 B')
    expect(formatReplayBytes(2048)).toBe('2 KB')
    expect(formatReplayBytes(1024 * 1024 * 1.5)).toBe('1.5 MB')
    expect(formatReplayBytes(undefined)).toBe('0 B')
  })

  it('行标题回落「会话 #id（已删除）」', () => {
    expect(replayRowTitle({ sessionId: 42, sessionTitle: null })).toBe('会话 #42（已删除）')
    expect(replayRowTitle({ sessionId: 42, sessionTitle: '有标题' })).toBe('有标题')
  })
})

describe('mapWithConcurrency', () => {
  it('并发不超过上限，结果保持入参顺序', async () => {
    let inFlight = 0
    let peak = 0
    const items = [1, 2, 3, 4, 5, 6, 7]
    const results = await mapWithConcurrency(items, 3, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return item * 2
    })
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('limit 非法回落 1；空列表直接空结果', async () => {
    const order: number[] = []
    const results = await mapWithConcurrency([1, 2], 0, async (item) => {
      order.push(item)
      return item
    })
    expect(results).toEqual([1, 2])
    expect(order).toEqual([1, 2])
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([])
  })

  it('单个失败不拖垮整体（调用方自行决定失败呈现）', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) throw new Error('boom')
      return item
    }).catch(() => 'rejected')
    expect(results).toBe('rejected')
  })
})

describe('LOCAL 行归属探测（共用设备他人遗留录制剔除，方案 §7 越权枚举）', () => {
  it('httpStatusOf：取 response.status，缺失/非数字归 0', () => {
    expect(httpStatusOf({ response: { status: 403 } })).toBe(403)
    expect(httpStatusOf({ response: { status: 404 } })).toBe(404)
    expect(httpStatusOf({ response: { status: '403' } })).toBe(0)
    expect(httpStatusOf(new Error('network'))).toBe(0)
    expect(httpStatusOf(undefined)).toBe(0)
  })

  it('localMetaOutcomeFromError：403 → FOREIGN 哨兵（整行剔除）', () => {
    expect(localMetaOutcomeFromError({ response: { status: 403 } })).toBe(LOCAL_META_FOREIGN)
  })

  it('localMetaOutcomeFromError：404（已删除）/ 网络故障 → null（保留占位行）', () => {
    expect(localMetaOutcomeFromError({ response: { status: 404 } })).toBeNull()
    expect(localMetaOutcomeFromError(new Error('network'))).toBeNull()
  })
})
