import type { Tab } from '../types/file-browser'

/**
 * 右侧边栏（TaskInspector）的展示对象：主会话 / 边路任务 / 子代理。
 * 文件 / Diff / 文件管理 Tab 只是浏览工具，没有独立会话，保持主会话视角；
 * 轨迹 Tab 展示的是另一个会话的 run，必须按 traceSessionId 归属回放。
 */
export type InspectorViewType = 'chat' | 'side_task' | 'subagent'

export interface InspectorTarget {
  viewType: InspectorViewType
  /** 展示对象的会话 id，直接作为 TaskInspector 的 sessionId */
  sessionId: string
  /** 子会话数字 id：重命名 / 删除等写操作用；主会话与占位态为 null */
  subSessionId: number | null
}

export interface InspectorScope {
  /** 主会话 id：chat / 文件类 Tab 与主会话自身的轨迹都归属它 */
  mainSessionId: string
  /** 当前主会话树下的边路任务（recursive 平铺，含深层后代） */
  sideTasks: ReadonlyArray<{ id: number }>
  /** 主会话 + 各边路任务名下的子代理（TaskView 已聚合成一份） */
  subagents: ReadonlyArray<{ id: number }>
}

function mainSessionTarget(mainSessionId: string): InspectorTarget {
  return { viewType: 'chat', sessionId: mainSessionId, subSessionId: null }
}

/**
 * 解析「右侧边栏该展示哪个会话」。
 *
 * 曾经这里只看 Tab 类型：只有 side_task / subagent 两类 Tab 会切到子会话，其余一律回落主会话。
 * 于是从边路任务 / 子代理视图点开运行轨迹后，中心区换成轨迹面板，右侧边栏却悄悄退回主会话的
 * 标题、状态、上下文与进度——排查时看到的全是另一个会话的信息。
 */
export function resolveInspectorTarget(tab: Tab | undefined, scope: InspectorScope): InspectorTarget {
  if (!tab) return mainSessionTarget(scope.mainSessionId)

  switch (tab.type) {
    case 'side_task':
    case 'subagent': {
      const sid = tab.sideSessionId
      // 占位边路 Tab（sideSessionId <= 0）首条消息发出前尚未落库，没有会话可展示
      if (sid == null || sid <= 0) break
      return { viewType: tab.type, sessionId: String(sid), subSessionId: sid }
    }
    case 'trace': {
      // 轨迹面板放的是 traceSessionId 那个会话的 run：主会话自身仍是单例 'trace'，
      // 边路 / 子代理则按 'trace:{sid}' 另开，边栏要跟着这个 id 走。
      const traceSid = tab.traceSessionId
      if (!traceSid || traceSid === scope.mainSessionId) break
      const sid = Number(traceSid)
      if (!Number.isInteger(sid) || sid <= 0) break
      if (scope.sideTasks.some(t => t.id === sid)) {
        return { viewType: 'side_task', sessionId: String(sid), subSessionId: sid }
      }
      if (scope.subagents.some(sa => sa.id === sid)) {
        return { viewType: 'subagent', sessionId: String(sid), subSessionId: sid }
      }
      // 归属未知（边路 / 子代理列表还没加载完，或子会话已被删除）：
      // 与 phase / todos / 上下文等字段一致先回落主会话，列表到达后 computed 自动收敛。
      break
    }
  }

  return mainSessionTarget(scope.mainSessionId)
}
