// Bugcheck：条带节点 key 唯一性（2026-10-23 审查 H-1）。
//
// 疑点：`toolNode` 的 key 是 `tool:${segmentKind}:${tool.toolCallId ?? tool.name}`。
// 用户手动文件写入 / Git 操作这类「未挂到轮」的活动（workspace-write.service.ts、
// git-write-operation.service.ts）detailJson 里没有 tool_call_id，toolCallId 为 null，
// name 取 activity.summary（如「用户删除」「Git 操作成功」）——同一 run 内出现两条
// 同类活动时 key 完全相同。
//
// 后果：v-for 重复 key（Vue 渲染错乱）、两个 tool-row 的行锚点 id 完全相同
// （HTML id 唯一性被破坏）、locateNode 的 getElementById 按文档序取到第一个 →
// 点第二条色条定位指到第一条行上。
//
// 同时对照：面板行渲染层的 :key 用 toolKey()（toolCallId | target | name），
// 说明行层预见到了这个维度，只有条带 key 与锚点 key 漏了。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { runTimeNodes } from './trace-display'
import type { RunTrace, TraceRound, TraceTool } from '../types/trace'

vi.mock('./toolDisplay', () => ({ getToolDisplayName: (name: string) => name }))

function makeTool(overrides: Partial<TraceTool> = {}): TraceTool {
  return {
    toolCallId: 'call_1',
    name: 'read_file',
    target: 'a.txt',
    status: 'OK',
    durationMs: 500,
    startedAtMs: 0,
    approvalMark: null,
    actor: null,
    ...overrides,
  }
}

function makeRound(overrides: Partial<TraceRound> = {}): TraceRound {
  return {
    seq: 1,
    modelName: 'step-5',
    scene: 'agent',
    createdAt: '2026-10-10 16:00:00',
    llmCallId: 101,
    startedAtMs: 0,
    provider: 'anthropic',
    durationMs: 1000,
    firstTokenMs: null,
    retryCount: 0,
    success: true,
    interrupted: false,
    errorMessage: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costMicros: null,
    slow: false,
    expensive: false,
    tools: [],
    ...overrides,
  }
}

function makeRun(overrides: Partial<RunTrace> = {}): RunTrace {
  return {
    runId: 11,
    userMessagePreview: '帮我改一下登录页',
    startedAt: '2026-10-10 16:00:00',
    segments: [{ kind: 'current', rounds: [makeRound()], unplacedTools: [] }],
    sideCalls: [],
    subagentLinks: [],
    markers: [],
    totals: {
      wallClockMs: 60_000, costMicros: null, promptTokens: 0, completionTokens: 0,
      cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 2, toolError: 0,
    },
    ...overrides,
  }
}

describe('runTimeNodes key 唯一性', () => {
  it('H-1：toolCallId 为 null 的同类未挂轮工具产生重复 key', () => {
    // 用户在会话里手动删了两个文件：detailJson 无 tool_call_id，summary 同为「用户删除」
    const run = makeRun({
      segments: [{
        kind: 'current',
        rounds: [],
        unplacedTools: [
          makeTool({ toolCallId: null, name: '用户删除', target: 'a.txt' }),
          makeTool({ toolCallId: null, name: '用户删除', target: 'b.txt' }),
        ],
      }],
    })
    const nodes = runTimeNodes(run)
    const toolNodes = nodes.filter((n) => n.kind === 'tool')
    expect(toolNodes).toHaveLength(2)
    // 期望：两条不同的工具行 → 两个不同的 key
    expect(new Set(nodes.map((n) => n.key)).size).toBe(nodes.length)
  })

  it('H-1：toolCallId 为 null 的同类轮内工具同样重复（git 操作连续两次）', () => {
    const run = makeRun({
      segments: [{
        kind: 'current',
        rounds: [makeRound({
          tools: [
            makeTool({ toolCallId: null, name: 'Git 操作成功', target: 'main' }),
            makeTool({ toolCallId: null, name: 'Git 操作成功', target: 'main' }),
          ],
        })],
        unplacedTools: [],
      }],
    })
    const keys = runTimeNodes(run).map((n) => n.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('行渲染层的 :key 与条带 key 同源，跨轮 / 未挂轮工具不重复', () => {
    // 与 RunTracePanel.vue 的 toolKey() 同口径
    const tools = [
      makeTool({ toolCallId: null, name: '用户删除', target: 'a.txt' }),
      makeTool({ toolCallId: null, name: '用户删除', target: 'b.txt' }),
    ]
    const rowKeys = tools.map((t) => `${t.toolCallId ?? ''}|${t.target ?? ''}|${t.name}`)
    expect(new Set(rowKeys).size).toBe(2)

    // 修复前：条带 key 只有 toolCallId|name，两条同类活动撞成一个
    const bandKeys = tools.map((t) => `tool:current:${t.toolCallId ?? t.name}`)
    expect(new Set(bandKeys).size).toBe(1)

    // 修复后：条带 key 与行锚点 key 都带 target 维度 + 段内序号，且同源
    const fixedBandKeys = tools.map((t, i) => `tool:current:${t.toolCallId ?? ''}|${t.target ?? ''}|${t.name}|${i}`)
    expect(new Set(fixedBandKeys).size).toBe(2)

    const panelSource = readFileSync(new URL('../components/center/RunTracePanel.vue', import.meta.url), 'utf8')
    expect(panelSource).toContain('function toolKey(tool: TraceTool): string {')
    expect(panelSource).toContain('function toolRowKey(run: RunTrace, tool: TraceTool): string {')
    expect(panelSource).toContain('function toolRowAnchor(run: RunTrace, tool: TraceTool): string {')
    expect(panelSource).toContain('runTimeNodes(run)')
  })

  it('既有正确性基线：toolCallId 非 null 时 key 跨段唯一', () => {
    const run = makeRun({
      segments: [
        { kind: 'before_edit', rounds: [makeRound({ seq: 1 })], unplacedTools: [] },
        { kind: 'current', rounds: [makeRound({ seq: 1 })], unplacedTools: [] },
      ],
    })
    const keys = runTimeNodes(run).map((n) => n.key)
    expect(keys).toContain('round:before_edit:1')
    expect(keys).toContain('round:current:1')
    expect(new Set(keys).size).toBe(keys.length)
  })
})
