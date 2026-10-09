import type { RunTrace, TraceTool, UnattributedGroup } from '../types/trace'
import { llmCallSceneLabel } from './llmCallLabels'

/**
 * 轨迹导出（技术方案 §5.5）。
 * CSV 口径对齐管理后台 llm-calls 导出：成本 = cost_micros / 1e6 六位小数、未配价留空、
 * UTF-8 BOM、CRLF、单元格双引号转义。中断写「已中断」，不写成「失败」。
 */

const CSV_HEADER = [
  'runId', '段', '序号', '种类', '时间', '模型', '场景',
  '输入 Token', '输出 Token', '缓存 Token', '缓存写 Token',
  '成本', '耗时(ms)', '状态', '错误信息', '名称', '目标', '审批'
]

/** 段：未编辑过时只有 current；编辑重发时 before_edit 在前。 */
function segmentLabel(kind: 'before_edit' | 'current'): string {
  return kind === 'before_edit' ? '编辑前' : '当前'
}

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function costCell(costMicros: number | null): string {
  return costMicros == null ? '' : (costMicros / 1_000_000).toFixed(6)
}

function toolStatusCell(tool: TraceTool): string {
  if (tool.status === 'ERROR') return '失败'
  return '成功'
}

/** 模型行（round / side）：token、成本、场景都填；名称 / 目标 / 审批留空。
 * runId 传 null 表示未归属行（不属于任何 run），该列留空。 */
function modelRow(runId: number | null, segment: string, row: {
  seq: number | null
  kind: 'round' | 'side'
  createdAt: string | null
  modelName: string | null
  scene: string
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  costMicros: number | null
  durationMs: number
  success: boolean
  interrupted: boolean
  errorMessage: string | null
}): string {
  const status = row.interrupted ? '已中断' : (row.success ? '成功' : '失败')
  return [
    runId ?? '',
    segment,
    row.seq ?? '',
    row.kind === 'side' ? 'side' : 'round',
    row.createdAt ?? '',
    row.modelName ?? '',
    llmCallSceneLabel(row.scene),
    row.promptTokens,
    row.completionTokens,
    row.cachedTokens,
    row.cacheCreationTokens,
    costCell(row.costMicros),
    row.durationMs,
    status,
    row.errorMessage ?? '',
    '',
    '',
    ''
  ].map(csvCell).join(',')
}

/** 工具行：token / 成本 / 场景留空，种类 = tool。runId 传 null 表示未归属行。 */
function toolRow(runId: number | null, segment: string, tool: TraceTool): string {
  return [
    runId ?? '',
    segment,
    '',
    'tool',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    tool.durationMs ?? '',
    toolStatusCell(tool),
    '',
    tool.name,
    tool.target ?? '',
    tool.approvalMark ?? ''
  ].map(csvCell).join(',')
}

/** 未归属组没有 run / 段概念：runId 与段留空，轮按原 scene 出行。 */
function unattributedRows(group: UnattributedGroup): string[] {
  const lines: string[] = []
  for (const round of group.rounds) {
    lines.push(modelRow(null, '', {
      seq: round.seq,
      kind: 'round',
      createdAt: round.createdAt,
      modelName: round.modelName,
      scene: round.scene,
      promptTokens: round.promptTokens,
      completionTokens: round.completionTokens,
      cachedTokens: round.cachedTokens,
      cacheCreationTokens: round.cacheCreationTokens,
      costMicros: round.costMicros,
      durationMs: round.durationMs,
      success: round.success,
      interrupted: round.interrupted,
      errorMessage: round.errorMessage,
    }))
  }
  for (const tool of group.tools) {
    lines.push(toolRow(null, '', tool))
  }
  return lines
}

export function buildTraceCsv(runs: RunTrace[], unattributed: UnattributedGroup | null): string {
  const lines = [CSV_HEADER.map(csvCell).join(',')]
  for (const run of runs) {
    for (const segment of run.segments) {
      const label = segmentLabel(segment.kind)
      for (const round of segment.rounds) {
        lines.push(modelRow(run.runId, label, {
          seq: round.seq,
          kind: 'round',
          createdAt: round.createdAt,
          modelName: round.modelName,
          scene: round.scene,
          promptTokens: round.promptTokens,
          completionTokens: round.completionTokens,
          cachedTokens: round.cachedTokens,
          cacheCreationTokens: round.cacheCreationTokens,
          costMicros: round.costMicros,
          durationMs: round.durationMs,
          success: round.success,
          interrupted: round.interrupted,
          errorMessage: round.errorMessage,
        }))
        for (const tool of round.tools) {
          lines.push(toolRow(run.runId, label, tool))
        }
      }
      for (const tool of segment.unplacedTools) {
        lines.push(toolRow(run.runId, label, tool))
      }
    }
    for (const side of run.sideCalls) {
      lines.push(modelRow(run.runId, '旁路', {
        seq: null,
        kind: 'side',
        createdAt: side.createdAt,
        modelName: side.modelName,
        scene: side.scene,
        promptTokens: side.promptTokens,
        completionTokens: side.completionTokens,
        cachedTokens: side.cachedTokens,
        cacheCreationTokens: side.cacheCreationTokens,
        costMicros: side.costMicros,
        durationMs: side.durationMs,
        success: side.success,
        interrupted: false,
        errorMessage: null,
      }))
    }
  }
  if (unattributed != null) {
    lines.push(...unattributedRows(unattributed))
  }
  // BOM 保证 Excel 打开中文不乱码
  return '\ufeff' + lines.join('\r\n')
}

export interface TraceExportPayload {
  runs: RunTrace[]
  unattributed: UnattributedGroup | null
}

/** JSON 结构与 /trace 接口一致：逐页拼成 { runs, unattributed }。 */
export function buildTraceJson(payload: TraceExportPayload): string {
  return JSON.stringify({ runs: payload.runs, unattributed: payload.unattributed }, null, 2)
}

function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` })
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}

export function downloadTraceJson(payload: TraceExportPayload, sessionId: string): void {
  downloadText(buildTraceJson(payload), `run-trace-${sessionId}-${stamp()}.json`, 'application/json')
}

export function downloadTraceCsv(payload: TraceExportPayload, sessionId: string): void {
  downloadText(buildTraceCsv(payload.runs, payload.unattributed), `run-trace-${sessionId}-${stamp()}.csv`, 'text/csv')
}
