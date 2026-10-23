// Bugcheck：traceRecords 缓存容量（2026-10-23 审查 M-2）。
//
// desktop/src/stores/session/trace.ts:60 / :133-140：
//   const traceRecords = ref<Map<string, Map<string, TraceLoadedRecord>>>(new Map())
//   function setTraceRecord(sessionId, key, record) {
//     const bucket = traceRecords.value.get(sid) ?? new Map()
//     bucket.set(key, record)          // ← 无条数上限、无 LRU、无字节估算
//     ...
//   }
//
// 清理路径只有两条：
//   clearTraceRecords(sessionId)  ← 仅删会话 / 登出（session.ts:33 purgeSessionRuntime）
//   reset()                       ← 登出
// 而 clearTrace(sessionId)（切会话 / 清轨迹）虽是导出成员，全仓库无人调用，
// 也不清理 traceRecords。
//
// 结果：正常使用路径下缓存单调增长、无上界。
// 增长模式限定：key 是 tool:${toolCallId} / call:${llmCallId}，每个工具/轮次只对应
// 一个 key，重复点开同一条不新增条目——累积速度是「本会话不同工具/轮次数 × 点开比例」，
// 不是「点开次数」。定级低：单次增长有上界（= 会话工具总数），主要问题是缺少与
// clearTrace 联动的释放点，以及敏感正文的驻留窗口。
import { describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import { createTraceModule } from './trace'
import type { TraceLoadedRecord } from '../../types/trace'

function toolRecord(key: string, bodyBytes: number): TraceLoadedRecord {
  return {
    kind: 'tool',
    data: {
      toolCallId: key,
      toolName: 'read_file',
      argumentsJson: '{}',
      // 用大字符串模拟 read_file 大文件 / shell 长输出的正文
      resultContent: 'x'.repeat(bodyBytes),
      resultMetadata: null,
      call: null,
    },
  } as unknown as TraceLoadedRecord
}

function mountTrace() {
  const app = createApp({})
  // trace 模块内部用 localStorage（loadThresholds）：node 环境垫一个
  const storage = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
  }
  const trace = createTraceModule()
  // 让 ref 脱离组件上下文也能读写（pinia store 语义的等价物）
  void app
  return trace
}

describe('traceRecords 缓存容量', () => {
  it('M-2：同一会话连续写入任意数量的记录都不淘汰（无上限）', () => {
    const trace = mountTrace()
    const total = 600
    for (let i = 0; i < total; i++) {
      trace.setTraceRecord('11', `tool:call_${i}`, toolRecord(`call_${i}`, 4096))
    }
    // 期望：缓存有条数上限，超出后最早的记录被淘汰（正文不再无界常驻）
    // 实际：全部常驻，600 条 × 4KB 正文 = 约 2.4MB 起，且随点开次数继续涨
    let resident = 0
    for (let i = 0; i < total; i++) {
      if (trace.getTraceRecord('11', `tool:call_${i}`) != null) resident += 1
    }
    expect(resident).toBeLessThan(total)
  })

  it('M-2：clearTrace（切会话 / 清轨迹）应一并释放 records 正文', () => {
    const trace = mountTrace()
    for (let i = 0; i < 50; i++) {
      trace.setTraceRecord('11', `tool:call_${i}`, toolRecord(`call_${i}`, 1024))
    }
    // 用户切走再切回 / 或触发清轨迹语义
    trace.clearTrace('11')
    // 期望：清轨迹时 records 一起释放（正文是敏感数据，不该在不清轨迹时也一直留着）
    // 实际：records 桶仍在——clearTrace 只清 runs/hasMore/unattributed/loading
    expect(trace.getTraceRecord('11', 'tool:call_0')).toBeNull()
  })

  it('M-2：跨会话桶有总上限，点开很多会话也不会无界累积', () => {
    const trace = mountTrace()
    for (let s = 0; s < 40; s++) {
      trace.setTraceRecord(`s${s}`, 'tool:call_0', toolRecord('call_0', 1024))
    }
    // 单会话 200 条之外，跨会话桶也要有上限：最早的会话桶被淘汰
    expect(trace.getTraceRecord('s0', 'tool:call_0')).toBeNull()
    expect(trace.getTraceRecord('s39', 'tool:call_0')).not.toBeNull()
  })

  it('正确性基线：删会话时 records 随会话一起清掉（不跨会话残留正文）', () => {
    const trace = mountTrace()
    trace.setTraceRecord('11', 'tool:call_0', toolRecord('call_0', 1024))
    trace.setTraceRecord('12', 'tool:call_0', toolRecord('call_0', 1024))
    trace.clearTraceRecords('11')
    expect(trace.getTraceRecord('11', 'tool:call_0')).toBeNull()
    // 别的会话不受影响
    expect(trace.getTraceRecord('12', 'tool:call_0')).not.toBeNull()
  })
})
