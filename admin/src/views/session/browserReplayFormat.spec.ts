import { describe, expect, it } from 'vitest'
import {
  BROWSER_REPLAY_SENSITIVE_NOTICE,
  BROWSER_REPLAY_TTL_DAYS_DEFAULT,
  browserReplayEmptyHint,
  browserReplayTruncatedTip,
  formatBytes,
  formatDuration,
  formatReplayTime,
  replayListParams,
  replaySessionTitle,
  replayStatusTags,
  type BrowserReplayFilters
} from './browserReplayFormat'

function filtersOf(overrides: Partial<BrowserReplayFilters> = {}): BrowserReplayFilters {
  return {
    userId: null,
    agentId: null,
    sessionId: null,
    keyword: '',
    activityRange: '7D',
    activityCustomRange: null,
    ...overrides
  }
}

describe('replayStatusTags（状态徽标）', () => {
  it('正常结算场 → 单枚「正常」', () => {
    expect(replayStatusTags({ endedAt: 1000, truncated: false })).toEqual([{ label: '正常', type: 'success' }])
  })
  it('未正常结束（endedAt=null）', () => {
    expect(replayStatusTags({ endedAt: null, truncated: false })).toEqual([{ label: '未正常结束', type: 'warning' }])
  })
  it('已截断', () => {
    expect(replayStatusTags({ endedAt: 1000, truncated: true })).toEqual([{ label: '已截断', type: 'danger' }])
  })
  it('未结束 + 已截断可叠加', () => {
    expect(replayStatusTags({ endedAt: null, truncated: true }).map((t) => t.label)).toEqual(['未正常结束', '已截断'])
  })
})

describe('formatDuration（时长列）', () => {
  it('未结算场（durationMs=null）展示「未结束」', () => {
    expect(formatDuration(null)).toBe('未结束')
    expect(formatDuration(undefined)).toBe('未结束')
    expect(formatDuration(-1)).toBe('未结束')
  })
  it('秒 / 分秒', () => {
    expect(formatDuration(0)).toBe('0 秒')
    expect(formatDuration(45_400)).toBe('45 秒')
    expect(formatDuration(60_000)).toBe('1 分 0 秒')
    expect(formatDuration(125_000)).toBe('2 分 5 秒')
  })
})

describe('formatBytes（体积列）', () => {
  it('B / KB / MB 分档', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(1_572_864)).toBe('1.5 MB')
  })
  it('缺失 / 非法回落 -', () => {
    expect(formatBytes(undefined)).toBe('-')
    expect(formatBytes(-5)).toBe('-')
  })
})

describe('formatReplayTime（epoch ms → 北京时间）', () => {
  it('按 Asia/Shanghai 格式化为 YYYY-MM-DD HH:mm:ss', () => {
    expect(formatReplayTime(Date.UTC(2026, 10, 27, 4, 5, 6))).toBe('2026-11-27 12:05:06')
  })
  it('无效值回落 -', () => {
    expect(formatReplayTime(null)).toBe('-')
    expect(formatReplayTime(undefined)).toBe('-')
    expect(formatReplayTime(0)).toBe('-')
    expect(formatReplayTime(Number.NaN)).toBe('-')
  })
})

describe('replaySessionTitle（会话标题列）', () => {
  it('有标题用标题，缺失回落「会话 #id」', () => {
    expect(replaySessionTitle({ sessionId: 7, sessionTitle: '查资料' })).toBe('查资料')
    expect(replaySessionTitle({ sessionId: 7, sessionTitle: null })).toBe('会话 #7')
  })
})

describe('replayListParams（筛选参数序列化）', () => {
  it('默认只带分页 + range=7D（后端同口径兜底）', () => {
    expect(replayListParams(filtersOf(), 2, 20)).toEqual({ page: 2, size: 20, range: '7D' })
  })
  it('预设档位透传，不展开日期', () => {
    expect(replayListParams(filtersOf({ activityRange: '1D' }), 1, 20).range).toBe('1D')
    expect(replayListParams(filtersOf({ activityRange: '90D' }), 1, 20).range).toBe('90D')
    expect(replayListParams(filtersOf({ activityRange: 'ALL' }), 1, 20).range).toBe('ALL')
  })
  it('自定义档转 dateFrom/dateTo', () => {
    const params = replayListParams(
      filtersOf({ activityRange: 'CUSTOM', activityCustomRange: ['2026-11-01', '2026-11-20'] }),
      1,
      50
    )
    expect(params).toEqual({ page: 1, size: 50, dateFrom: '2026-11-01', dateTo: '2026-11-20' })
  })
  it('自定义档区间不全时不发日期，交后端默认兜底', () => {
    expect(replayListParams(filtersOf({ activityRange: 'CUSTOM', activityCustomRange: null }), 1, 20)).toEqual({
      page: 1,
      size: 20
    })
  })
  it('用户 / Agent / 会话深链 / 关键词（去空白）按需下发', () => {
    const params = replayListParams(
      filtersOf({ userId: 3, agentId: 9, sessionId: 12, keyword: '  标题  ' }),
      1,
      20
    )
    expect(params).toMatchObject({ userId: 3, agentId: 9, sessionId: 12, keyword: '标题' })
  })
  it('空关键词 / 0 值不下发', () => {
    const params = replayListParams(filtersOf({ userId: 0, agentId: 0, sessionId: 0, keyword: '   ' }), 1, 20)
    expect(params).not.toHaveProperty('userId')
    expect(params).not.toHaveProperty('agentId')
    expect(params).not.toHaveProperty('sessionId')
    expect(params).not.toHaveProperty('keyword')
  })
})

describe('候选截断提示', () => {
  it('truncatedCandidates=true 给出缩小范围提示', () => {
    expect(browserReplayTruncatedTip(true)).toBe('候选过多，请缩小时间/用户范围')
  })
  it('false / 缺失无提示', () => {
    expect(browserReplayTruncatedTip(false)).toBeNull()
    expect(browserReplayTruncatedTip(undefined)).toBeNull()
  })
})

describe('提示文案', () => {
  it('敏感信息横幅：审计 + LOCAL 不可见', () => {
    expect(BROWSER_REPLAY_SENSITIVE_NOTICE).toContain('访问会记录审计')
    expect(BROWSER_REPLAY_SENSITIVE_NOTICE).toContain('LOCAL')
  })
  it('空态引导含录制开关路径与默认保留天数', () => {
    const hint = browserReplayEmptyHint()
    expect(hint).toContain('系统设置 → 浏览器直播 → 启用操作录制')
    expect(hint).toContain(`默认保留 ${BROWSER_REPLAY_TTL_DAYS_DEFAULT} 天`)
    expect(browserReplayEmptyHint(30)).toContain('默认保留 30 天')
  })
})
