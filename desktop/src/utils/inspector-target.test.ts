import { describe, expect, it } from 'vitest'
import type { Tab } from '../types/file-browser'
import { resolveInspectorTarget, type InspectorScope } from './inspector-target'

/**
 * 回归：从边路任务 / 子代理视图点开运行轨迹后，右侧边栏曾悄悄退回主会话。
 *
 * 轨迹 Tab（type='trace'）此前不参与「边栏展示哪个会话」的判定，于是边栏的标题 /
 * 状态 / 上下文 / 进度 / 模型全部回落到主会话——排查时看到的是另一个会话的信息。
 * 边栏必须按 traceSessionId 归属回放，主会话自身的轨迹才保持主会话视角。
 */

const MAIN = '11'
const SIDE = 7
const SUBAGENT = 23

function scope(over: Partial<InspectorScope> = {}): InspectorScope {
  return {
    mainSessionId: MAIN,
    sideTasks: [{ id: SIDE }],
    subagents: [{ id: SUBAGENT }],
    ...over,
  }
}

function tab(over: Partial<Tab>): Tab {
  return { id: 'chat', type: 'chat', title: '主会话', ...over }
}

describe('resolveInspectorTarget 轨迹 Tab 归属', () => {
  it('主会话自身的轨迹（单例 trace）保持主会话视角', () => {
    const target = resolveInspectorTarget(tab({ id: 'trace', type: 'trace', traceSessionId: MAIN }), scope())
    expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
  })

  it('主会话轨迹缺省 traceSessionId 时也保持主会话视角', () => {
    const target = resolveInspectorTarget(tab({ id: 'trace', type: 'trace' }), scope())
    expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
  })

  it('边路任务的轨迹（trace:{sid}）把边栏切到该边路会话', () => {
    const target = resolveInspectorTarget(
      tab({ id: `trace:${SIDE}`, type: 'trace', title: '轨迹 · 提交代码并部署', traceSessionId: String(SIDE) }),
      scope(),
    )
    expect(target).toEqual({ viewType: 'side_task', sessionId: String(SIDE), subSessionId: SIDE })
  })

  it('子代理的轨迹把边栏切到该子代理会话', () => {
    const target = resolveInspectorTarget(
      tab({ id: `trace:${SUBAGENT}`, type: 'trace', title: '轨迹 · 检索资料', traceSessionId: String(SUBAGENT) }),
      scope(),
    )
    expect(target).toEqual({ viewType: 'subagent', sessionId: String(SUBAGENT), subSessionId: SUBAGENT })
  })

  it('边路 / 子代理列表还没加载完时先回落主会话，列表到达后自动收敛', () => {
    // phase / todos / 上下文等字段沿用同样的回落口径，避免边栏空掉
    const target = resolveInspectorTarget(
      tab({ id: 'trace:99', type: 'trace', traceSessionId: '99' }),
      scope(),
    )
    expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
  })

  it('深层后代边路任务也在平铺列表里，同样能归属', () => {
    const deep = 41
    const target = resolveInspectorTarget(
      tab({ id: `trace:${deep}`, type: 'trace', traceSessionId: String(deep) }),
      scope({ sideTasks: [{ id: SIDE }, { id: deep }] }),
    )
    expect(target).toEqual({ viewType: 'side_task', sessionId: String(deep), subSessionId: deep })
  })
})

describe('resolveInspectorTarget 其余 Tab 类型', () => {
  it('side_task Tab 仍是该边路会话', () => {
    const target = resolveInspectorTarget(tab({ id: `side:${SIDE}`, type: 'side_task', sideSessionId: SIDE }), scope())
    expect(target).toEqual({ viewType: 'side_task', sessionId: String(SIDE), subSessionId: SIDE })
  })

  it('subagent Tab 仍是该子代理会话', () => {
    const target = resolveInspectorTarget(
      tab({ id: `subagent:${SUBAGENT}`, type: 'subagent', sideSessionId: SUBAGENT }),
      scope(),
    )
    expect(target).toEqual({ viewType: 'subagent', sessionId: String(SUBAGENT), subSessionId: SUBAGENT })
  })

  it('占位边路 Tab（sideSessionId <= 0）尚未落库，回落主会话且不带子会话 id', () => {
    const target = resolveInspectorTarget(tab({ id: 'side:0', type: 'side_task', sideSessionId: 0 }), scope())
    expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
  })

  it('文件 / Diff / 文件管理只是浏览工具，保持主会话视角', () => {
    for (const type of ['file', 'diff', 'file_manager'] as const) {
      const target = resolveInspectorTarget(tab({ id: 'x', type, title: 'a.ts' }), scope())
      expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
    }
  })

  it('主会话 chat Tab 保持主会话视角', () => {
    const target = resolveInspectorTarget(tab({}), scope())
    expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
  })

  it('没有 Tab（chat 隐式）时不炸，回落主会话', () => {
    expect(resolveInspectorTarget(undefined, scope())).toEqual({
      viewType: 'chat',
      sessionId: MAIN,
      subSessionId: null,
    })
  })

  it('新建态（主会话 id 为空）不把空串当会话 id', () => {
    const target = resolveInspectorTarget(
      tab({ id: 'trace', type: 'trace', traceSessionId: '' }),
      scope({ mainSessionId: '' }),
    )
    expect(target).toEqual({ viewType: 'chat', sessionId: '', subSessionId: null })
  })

  it('非法的 traceSessionId（0 / 负数 / 非数字）不冒充会话 id', () => {
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const target = resolveInspectorTarget(tab({ id: 'trace', type: 'trace', traceSessionId: bad }), scope())
      expect(target).toEqual({ viewType: 'chat', sessionId: MAIN, subSessionId: null })
    }
  })
})
