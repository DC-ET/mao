import { describe, expect, it } from 'vitest'
import { summarizeRuns } from './trace-display'
import type { RunTrace } from '../types/trace'

/**
 * 运行轨迹 token 总量口径回归。
 *
 * 统一 ChatUsage 的 promptTokens 是「总输入」，已包含缓存命中（OpenAI 的
 * prompt_tokens_details.cached_tokens）与缓存写入（Anthropic finalizeUsage 的
 * input + cache_creation + cache_read）。因此总量只能是
 * promptTokens + completionTokens，cachedTokens / cacheCreationTokens 只是分项。
 */
function makeRun(totals: Partial<RunTrace['totals']> = {}): RunTrace {
  return {
    runId: 1,
    userMessagePreview: 'hi',
    startedAt: '2026-10-17 10:00:00',
    segments: [],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 1000,
      costMicros: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      toolSuccess: 0,
      toolError: 0,
      ...totals,
    },
  }
}

describe('summarizeRuns token 总量', () => {
  it('对照组：无缓存时 prompt + completion', () => {
    const summary = summarizeRuns([makeRun({ promptTokens: 100, completionTokens: 20 })])
    expect(summary.tokens).toBe(120)
  })

  it('回归：缓存命中 token 已含在 promptTokens 内，不应再加一次', () => {
    const summary = summarizeRuns([
      makeRun({ promptTokens: 1000, completionTokens: 100, cachedTokens: 800 }),
    ])
    // 正确 1100；当前实现输出 1900
    expect(summary.tokens).toBe(1100)
  })
})
