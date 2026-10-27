/** 解码耗时与吞吐量（技术方案 2026-10-27-llm-output-speed §3.2）。
 *  与 desktop src/utils/throughput.ts 同口径：admin 是独立工程不能共享代码，
 *  按仓库既有模式（llmCallLabels.ts 两端各一份）维护副本——改这里必须同步 desktop 那份。
 *  两处的计算口径与边界用例（非流式 / 时钟异常 / 零输出 / 零解码）保持一致；
 *  唯一有意不同的是空值字形：admin 随本端 formatMs / formatCost 用「-」，桌面端用「—」。 */

export interface ThroughputInput {
  durationMs: number | null
  firstTokenMs: number | null
  completionTokens: number | null
}

/** 解码耗时 = durationMs − firstTokenMs；首字缺失（非流式调用）或晚于结束（时钟异常）时为 null。 */
export function decodingMs(row: ThroughputInput): number | null {
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

/** 单行吞吐展示：1 位小数 + 单位；null → 「-」（与 admin formatMs / formatCost 的空值口径一致，
 *  桌面端用「—」，两端各自随本端惯例）。 */
export function formatThroughput(row: ThroughputInput): string {
  const value = throughput(row)
  return value == null ? '-' : `${value.toFixed(1)} tok/s`
}

/** 聚合值展示（模型均值 / 会话分位由后端算好直接给数）：1 位小数 + 单位；null → 「—」。 */
export function formatTps(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(1)} tok/s`
}
