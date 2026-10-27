/** 解码耗时与吞吐量的统一口径（技术方案 2026-10-27-llm-output-speed §3.1）。
 *  从 trace-display.ts 抽出：运行轨迹（TraceRound）与用量明细 / 分析（MyLlmCallRecord、
 *  admin 调用行）共用同一份实现——同一数字只允许一个真相，两处各算一遍必然对不上。
 *  入参是最小结构（字段均可空）：轨迹行与用量行都能直接传。
 *  admin 是独立工程，在 admin/src/utils/throughput.ts 维护同口径副本，改这里必须同步那边。 */
export interface DecodingInput {
  durationMs: number | null
  firstTokenMs: number | null
}

/** 吞吐量入参：解码耗时之外还需要输出 tokens（轨迹行与用量行都有该字段）。 */
export interface ThroughputInput extends DecodingInput {
  completionTokens: number | null
}

/** 解码耗时 = durationMs − firstTokenMs；首字缺失（非流式调用）或晚于结束（时钟异常）时为 null。 */
export function decodingMs(row: DecodingInput): number | null {
  if (row.firstTokenMs == null || row.durationMs == null) return null
  if (row.firstTokenMs > row.durationMs) return null
  return row.durationMs - row.firstTokenMs
}

/** 吞吐量 = 输出 token ÷ 解码秒；解码不可算或为 0、输出为 0 时为 null（不显示 0 误导）。 */
export function throughput(row: ThroughputInput): number | null {
  const decode = decodingMs(row)
  if (decode == null || decode <= 0) return null
  if (row.completionTokens == null || row.completionTokens <= 0) return null
  return row.completionTokens / (decode / 1000)
}

/** 吞吐量展示：1 位小数 + 单位；null → 「—」。 */
export function formatThroughput(row: ThroughputInput): string {
  const value = throughput(row)
  return value == null ? '—' : `${value.toFixed(1)} tok/s`
}

/** 聚合口径（技术方案 §5.1 决策 D4）：加权平均 = Σ输出 ÷ Σ解码秒。
 *  窗口内没有可解码行（decodeMs 为 0，例如全非流式）时为 null，不显示 0 误导。 */
export function avgThroughput(totals: { decodeTokens: number; decodeMs: number }): number | null {
  if (totals.decodeMs <= 0 || totals.decodeTokens <= 0) return null
  return totals.decodeTokens / (totals.decodeMs / 1000)
}

/** 聚合吞吐展示：1 位小数 + 单位；null → 「—」。 */
export function formatAvgThroughput(totals: { decodeTokens: number; decodeMs: number }): string {
  const value = avgThroughput(totals)
  return value == null ? '—' : `${value.toFixed(1)} tok/s`
}
