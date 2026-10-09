import { describe, expect, it } from 'vitest'
import { buildTraceCsv, buildTraceJson } from './trace-export'
import type { RunTrace, UnattributedGroup } from '../types/trace'

/** 去掉 BOM 后按逗号切字段：测出的列序即 CSV 表头列序。 */
function csvCells(line: string): string[] {
  return line.replace(/^\ufeff/, '').split(',')
}

function makeRun(overrides: Partial<RunTrace> = {}): RunTrace {  return {
    runId: 11,
    userMessagePreview: '帮我改一下登录页',
    startedAt: '2026-10-09 10:00:00',
    segments: [
      {
        kind: 'current',
        rounds: [
          {
            seq: 1,
            modelName: 'claude-sonnet',
            scene: 'agent',
            createdAt: '2026-10-09 10:00:05',
            durationMs: 4200,
            firstTokenMs: 800,
            retryCount: 0,
            success: true,
            interrupted: false,
            errorMessage: null,
            promptTokens: 1000,
            completionTokens: 200,
            cachedTokens: 300,
            cacheCreationTokens: 40,
            costMicros: 1234567,
            slow: false,
            expensive: false,
            tools: [
              {
                toolCallId: 'call_1',
                name: 'read_file',
                target: 'src/login.ts',
                status: 'SUCCESS',
                durationMs: 120,
                approvalMark: '低风险放行',
              },
            ],
          },
        ],
        unplacedTools: [
          {
            toolCallId: null,
            name: 'shell',
            target: 'npm test',
            status: 'ERROR',
            durationMs: null,
            approvalMark: null,
          },
        ],
      },
    ],
    sideCalls: [
      {
        scene: 'session_title',
        modelName: 'gpt-4o-mini',
        createdAt: '2026-10-09 10:00:06',
        durationMs: 300,
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 0,
        cacheCreationTokens: 0,
        costMicros: null,
        success: true,
      },
    ],
    subagentLinks: [],
    markers: [{ kind: 'compaction', atMessageId: 7, detail: '压缩前 12 条消息' }],
    totals: {
      wallClockMs: 4300,
      costMicros: 1234567,
      promptTokens: 1010,
      completionTokens: 205,
      cachedTokens: 300,
      cacheCreationTokens: 40,
      toolSuccess: 1,
      toolError: 1,
    },
    ...overrides,
  }
}

describe('buildTraceCsv', () => {
  it('按「runId/段/序号/种类」出行：轮、工具、未挂到轮、旁路各一行', () => {
    const csv = buildTraceCsv([makeRun()], null)
    const lines = csv.split('\r\n')
    // BOM + 表头 + 轮 + 轮内工具 + 未挂到轮 + 旁路
    expect(lines).toHaveLength(5)
    expect(lines[0]!.startsWith('\ufeffrunId,段,序号,种类,时间,模型,场景')).toBe(true)
    // 模型行：token / 成本 / 场景都填
    expect(csvCells(lines[1]!)).toEqual([
      '11', '当前', '1', 'round', '2026-10-09 10:00:05', 'claude-sonnet', '对话',
      '1000', '200', '300', '40', '1.234567', '4200', '成功', '', '', '', ''
    ])
    // 工具行：token / 成本 / 场景留空，种类 = tool
    expect(csvCells(lines[2]!)).toEqual([
      '11', '当前', '', 'tool', '', '', '', '', '', '', '', '',
      '120', '成功', '', 'read_file', 'src/login.ts', '低风险放行'
    ])
    // 未挂到轮：历史行没有 duration，留空
    expect(csvCells(lines[3]!)).toEqual([
      '11', '当前', '', 'tool', '', '', '', '', '', '', '', '',
      '', '失败', '', 'shell', 'npm test', ''
    ])
    // 旁路调用：序号留空，种类 side
    expect(csvCells(lines[4]!)).toEqual([
      '11', '旁路', '', 'side', '2026-10-09 10:00:06', 'gpt-4o-mini', '会话标题',
      '10', '5', '0', '0', '', '300', '成功', '', '', '', ''
    ])
  })

  it('中断写成「已中断」而不是「失败」', () => {
    const run = makeRun()
    run.segments[0]!.rounds[0]!.interrupted = true
    run.segments[0]!.rounds[0]!.errorMessage = 'Cancelled by user'
    run.segments[0]!.rounds[0]!.success = true
    const csv = buildTraceCsv([run], null)
    const roundLine = csv.split('\r\n')[1]!
    expect(roundLine).toContain('已中断')
    expect(roundLine).not.toContain('失败')
  })

  it('未配价（costMicros 为 null）成本列留空', () => {
    const run = makeRun()
    run.segments[0]!.rounds[0]!.costMicros = null
    const csv = buildTraceCsv([run], null)
    const round = csv.split('\r\n')[1]!
    expect(round).toContain('1000,200,300,40,,4200,成功')
  })

  it('未归属组排在末尾，runId 与段留空', () => {
    const unattributed: UnattributedGroup = {
      count: 2,
      startedAt: '2026-10-09 09:00:00',
      endedAt: '2026-10-09 09:00:09',
      rounds: [
        {
          seq: 1,
          modelName: 'claude-sonnet',
          scene: 'compaction',
          createdAt: '2026-10-09 09:00:09',
          durationMs: 9000,
          firstTokenMs: null,
          retryCount: 0,
          success: true,
          interrupted: false,
          errorMessage: null,
          promptTokens: 5000,
          completionTokens: 100,
          cachedTokens: 0,
          cacheCreationTokens: 0,
          costMicros: null,
          slow: false,
          expensive: false,
          tools: [],
        },
      ],
      tools: [],
    }
    const csv = buildTraceCsv([makeRun()], unattributed)
    const lines = csv.split('\r\n')
    expect(lines[lines.length - 1]!.startsWith(',,1,round,2026-10-09 09:00:09,claude-sonnet,上下文压缩')).toBe(true)
  })

  it('单元格内的逗号与引号按 CSV 规则转义', () => {
    const run = makeRun()
    run.segments[0]!.rounds[0]!.errorMessage = 'boom, "fatal"'
    run.segments[0]!.rounds[0]!.success = false
    const csv = buildTraceCsv([run], null)
    expect(csv).toContain('"boom, ""fatal"""')
  })
})

describe('buildTraceJson', () => {
  it('结构与 /trace 接口一致：{ runs, unattributed }', () => {
    const unattributed: UnattributedGroup = {
      count: 0,
      startedAt: null,
      endedAt: null,
      rounds: [],
      tools: [],
    }
    const parsed = JSON.parse(buildTraceJson({ runs: [makeRun()], unattributed }))
    expect(Object.keys(parsed)).toEqual(['runs', 'unattributed'])
    expect(parsed.runs).toHaveLength(1)
    expect(parsed.runs[0].runId).toBe(11)
    expect(parsed.unattributed.count).toBe(0)
  })
})
