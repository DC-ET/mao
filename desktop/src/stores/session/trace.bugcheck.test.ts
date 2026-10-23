import { describe, expect, it } from 'vitest'
import { createTraceModule } from './trace'

/**
 * 运行轨迹面板（desktop/src/components/center/RunTracePanel.vue）通过
 * getLiveExecutionId(sessionId) 决定展示哪一次执行的临时行（第 N 轮 / 进行中工具计时）。
 *
 * 临时行按 `${sessionId}|${executionId}` 存放在 Map 里；上一次执行的残留键不会自动消失
 * （例如重连路径 session_snapshot 的终态分支没有调用 clearLiveState），
 * 而 getLiveExecutionId 取的是「第一个匹配的键」（Map 的插入顺序 = 最旧的那个），
 * 于是当前执行的轮次与工具计时不显示，面板一直渲染上一次执行的「模型调用中」。
 */
describe('getLiveExecutionId 返回当前执行的 executionId', () => {
  it('同一会话存在上一次执行的残留时，必须返回最近一次执行的 executionId', () => {
    const trace = createTraceModule()

    trace.applyLiveRoundStart('12', 'exec-old', 1)
    trace.applyLiveRoundStart('12', 'exec-new', 1)

    expect(trace.getLiveExecutionId('12')).toBe('exec-new')
    expect(trace.getLiveRound('12', 'exec-new')).toEqual({ round: 1, inModelCall: true })
  })

  it('只有一次执行时返回该执行', () => {
    const trace = createTraceModule()
    trace.applyLiveRoundStart('12', 'exec-only', 3)
    expect(trace.getLiveExecutionId('12')).toBe('exec-only')
  })

  it('不同会话的临时行不串味', () => {
    const trace = createTraceModule()
    trace.applyLiveRoundStart('12', 'exec-a', 1)
    trace.applyLiveRoundStart('13', 'exec-b', 1)
    expect(trace.getLiveExecutionId('13')).toBe('exec-b')
    expect(trace.getLiveExecutionId('12')).toBe('exec-a')
  })
})
