import { ref, computed, watch, effectScope, type Ref } from 'vue'
import type { Tab, SessionTabState, SideTaskContextMode, SideTaskForkSource } from '../types/file-browser'
import type { FileChange } from '../types/chat'
import { getClosedSideTaskIds, markSideTaskClosed, unmarkSideTaskClosed, normalizeSideTaskTitle, type SideTaskSummary } from '../utils/side-task-tabs'
import { getPersistedActiveTab, persistActiveTab } from '../utils/center-active-tab'
import { retargetTabPath, type WorkspacePathChange } from '../utils/workspace-tab-paths'
import { useSessionStore } from '../stores/session'

/**
 * 边路任务创建入口的预置：上下文继承方式 + 分叉来源（按轮分叉时带切点）+ 来源会话。
 * sourceSessionId 缺省 = 主会话；从边路任务发起时为该边路会话 id（新边路的父会话）。
 */
export interface SideTaskEntryOptions {
  contextMode?: SideTaskContextMode
  fork?: SideTaskForkSource
  sourceSessionId?: number
}

// Module-level singleton state
const sessionTabsMap = ref<Map<string, SessionTabState>>(new Map())
const currentSessionId = ref('')

const CHAT_TAB: Tab = { id: 'chat', type: 'chat', title: '主会话' }

/**
 * 模块级边路任务 Tab 打开函数（供顶部搜索等脱离 TaskView 上下文的入口使用）。
 * 始终按显式 parentSessionId 操作模块级单例 Map，不依赖 currentSessionId——
 * 因此不受 router.push 异步加载会话的影响；restoreSideTaskTabs 只会合并数据、不重置已激活 Tab。
 */
export function openSideTaskTabFor(parentSessionId: string, sideSessionId: number, title: string) {
  if (!parentSessionId || sideSessionId <= 0) return
  // 从搜索结果重新打开：清除「用户曾关闭」记录，保证刷新后 restoreSideTaskTabs 仍能恢复该 Tab
  unmarkSideTaskClosed(parentSessionId, sideSessionId)
  const sid = String(parentSessionId)
  let state = sessionTabsMap.value.get(sid)
  if (!state) {
    state = { tabs: [], activeTabId: 'chat' }
    sessionTabsMap.value.set(sid, state)
  }
  const existing = state.tabs.find(t => t.type === 'side_task' && t.sideSessionId === sideSessionId)
  if (existing) {
    existing.title = normalizeSideTaskTitle(title)
    state.activeTabId = existing.id
  } else {
    const id = 'side:' + sideSessionId
    state.tabs.push({ id, type: 'side_task', title: normalizeSideTaskTitle(title), sideSessionId })
    state.activeTabId = id
  }
  notifyTabsChanged(sid)
}

function findSideTaskTab(state: SessionTabState, sideSessionId: number) {
  const id = 'side:' + sideSessionId
  return state.tabs.find(t =>
    t.type === 'side_task' && (t.id === id || t.sideSessionId === sideSessionId)
  )
}

export function updateSideTaskTabTitleFor(parentSessionId: string, sideSessionId: number, title: string) {
  const state = sessionTabsMap.value.get(String(parentSessionId))
  if (!state) return
  const tab = findSideTaskTab(state, sideSessionId)
  if (!tab) return
  tab.title = normalizeSideTaskTitle(title)
  sessionTabsMap.value = new Map(sessionTabsMap.value)
}

/** 会话删除后清理其 Tab 状态（模块级单例 Map，供删除入口直接调用，无需组件上下文）。 */
export function removeSessionTabsFor(sessionId: string) {
  // 激活态记录先清：会话已不存在，恢复时无处可跳。放在 has() 判断之前，
  // 否则「内存无 Tab 但 localStorage 有记录」的会话（如从未打开过的会话被删）会残留。
  persistActiveTab(String(sessionId), null)
  if (!sessionTabsMap.value.has(sessionId)) return
  sessionTabsMap.value.delete(sessionId)
  // Map 内部变更不会自动触发 computed，需要替换 Map 引用
  sessionTabsMap.value = new Map(sessionTabsMap.value)
}

/**
 * 登出/换号时清空全部中心 Tab 状态：sessionId 是服务端自增数字，
 * 换号后 ID 碰撞会复活上一账号的 Tab 条。
 */
export function resetCenterTabs() {
  sessionTabsMap.value = new Map()
  currentSessionId.value = ''
}

/**
 * Tab 数据变更后的统一收尾：替换 Map 引用让 computed 重新求值，并按需落盘激活态。
 *
 * 落盘只保留给「激活态真的变了」的入口（activeTabId 的 setter、各类 open*、activateTab、
 * closeTab/restoreActiveTab）。restoreSideTaskTabs / restoreSubagentTabs 只是合并 Tab
 * 数据、不动激活态，传 syncOnly 跳过落盘——否则它们会按此刻仍是 chat 的初始态写 null，
 * 把 restoreActiveTab 正要用的上一条记录擦掉。
 *
 * 注意 currentSessionId 可能尚未同步到目标会话（loadSession 中 setActiveSession 之后
 * 紧接着同步调用 restore*），因此按「本次变更涉及的会话」写入，而非只用 currentSessionId。
 */
function notifyTabsChanged(changedSessionId?: string, syncOnly = false) {
  const sid = changedSessionId || currentSessionId.value
  if (sid && !syncOnly) {
    const state = sessionTabsMap.value.get(sid)
    const activeId = state?.activeTabId || 'chat'
    const tab = state?.tabs.find(t => t.id === activeId)
    recordActiveTabFor(sid, tab ?? CHAT_TAB)
  }
  // Map 内部变更不会自动触发 computed，需要替换 Map 引用
  sessionTabsMap.value = new Map(sessionTabsMap.value)
}

/**
 * 把激活态写入 localStorage，供刷新 / 冷启动后 restoreSideTaskTabs 重建 Tab 时还原。
 *
 * 边路任务的锚点用 sideSessionId 而非 tab id：真实 Tab 的 id 由创建入口决定，
 * 本地新建走占位 id（side:-{timestamp}），updateSideTaskTab 又刻意不改 id（保持组件
 * 不重挂载）——记 id 会在刷新后匹配不到 restoreSideTaskTabs 重建出的 side:{realId} Tab。
 */
function recordActiveTabFor(sid: string, tab: Tab) {
  if (!sid) return
  if (tab.type === 'chat' || tab.id === 'chat') {
    persistActiveTab(sid, null)
    return
  }
  // 边路占位 Tab（sideSessionId <= 0）尚未落库：记了也无处恢复，跳过
  if (tab.type === 'side_task' && (tab.sideSessionId == null || tab.sideSessionId <= 0)) return
  if ((tab.type === 'side_task' || tab.type === 'subagent') && tab.sideSessionId != null && tab.sideSessionId > 0) {
    persistActiveTab(sid, { type: tab.type, sideSessionId: tab.sideSessionId })
    return
  }
  persistActiveTab(sid, { type: tab.type, tabId: tab.id })
}

// 仅注册一次：激活边路任务 Tab 时清除该边路任务的未读标记（按 sideSessionId 独立已读）。
// watch 注册在模块级 detached effectScope 中：否则它挂在首个调用组件的作用域上，
// 组件卸载（如切到 Settings）后 watch 永久失效但标志位仍为 true，已读逻辑彻底停摆。
// 数据源必须是模块级派生函数而非任一实例的 computed：setup 内创建的 computed 关联
// 组件 effect scope，组件卸载后该 computed 停止更新，watch 会读到陈旧值。
let sideTaskReadWatchRegistered = false
const sideTaskReadScope = effectScope(true)

/** 模块级派生：当前激活 Tab 的边路任务 ID（非 side_task Tab 返回 null）。 */
function resolveActiveSideTaskId(): number | null {
  const state = sessionTabsMap.value.get(currentSessionId.value)
  if (!state) return null
  const activeId = state.activeTabId || 'chat'
  if (activeId === 'chat') return null
  const tab = state.tabs.find(t => t.id === activeId)
  return tab && tab.type === 'side_task' && tab.sideSessionId != null && tab.sideSessionId > 0
    ? tab.sideSessionId
    : null
}

function ensureSideTaskReadWatch() {
  if (sideTaskReadWatchRegistered) return
  sideTaskReadWatchRegistered = true
  const sessionStore = useSessionStore()
  sideTaskReadScope.run(() => {
    // 监听「激活 tab 的 sideSessionId」而非 tab 对象——
    // 占位 Tab（sideSessionId<=0）经 side_session_created 更新为真实 id 时 tab 对象引用不变，
    // 若只 watch activeTab 将不触发，导致 viewingSideTaskId 未同步、已查看的边路任务圆点无法消除。
    watch(resolveActiveSideTaskId, (sid) => {
      sessionStore.setViewingSideTask(sid)
      if (sid != null) {
        void sessionStore.markSideTaskRead(sid)
      }
    }, { immediate: true })
  })
}

export function useCenterTabs(activeSessionId: Ref<string | null>) {
  // Sync currentSessionId with the provided ref
  watch(activeSessionId, (newId) => {
    const sid = newId ?? ''
    if (sid !== currentSessionId.value) {
      currentSessionId.value = sid
    }
  }, { immediate: true })

  /**
   * 取会话的 Tab 状态。sid 缺省用 currentSessionId；
   * 显式传 sid 给「调用方已知目标会话、但 currentSessionId 可能尚未同步」的还原入口用
   * （loadSession 里 setActiveSession 之后同步调用 restore*，watch 还没跑）。
   */
  function getSessionState(sid?: string): SessionTabState {
    const key = sid ?? currentSessionId.value
    if (!key) return { tabs: [], activeTabId: 'chat' }
    let state = sessionTabsMap.value.get(key)
    if (!state) {
      state = { tabs: [], activeTabId: 'chat' }
      sessionTabsMap.value.set(key, state)
    }
    return state
  }

  const tabs = computed<Tab[]>(() => {
    const state = getSessionState()
    return [CHAT_TAB, ...state.tabs]
  })

  const activeTabId = computed({
    get: () => getSessionState().activeTabId || 'chat',
    set: (val: string) => {
      const state = getSessionState()
      state.activeTabId = val
      notifyTabsChanged()
    }
  })

  const activeTab = computed(() => {
    return tabs.value.find(t => t.id === activeTabId.value) || CHAT_TAB
  })

  // 用户实际查看的边路任务：激活 side_task Tab 时清除其未读；切到其他 Tab 时记录为 null。
  // 完成事件据此判断是否标未读（不再以父会话激活推断已读）。
  ensureSideTaskReadWatch()

  function openFileTab(filePath: string, title: string) {
    const state = getSessionState()
    // Check if tab already exists
    const existing = state.tabs.find(t => t.type === 'file' && t.filePath === filePath)
    if (existing) {
      // Increment version to force remount, ensuring latest file content is loaded
      existing.version = (existing.version ?? 0) + 1
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    // Use relative path as id (from title which is the filename, but filePath for uniqueness)
    const id = 'file:' + filePath
    const newTab: Tab = { id, type: 'file', title, filePath, version: 0 }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  function openDiffTab(change: FileChange, title?: string, opts?: { source?: 'tool' | 'git' }) {
    const state = getSessionState()
    const filePath = change.path
    const source = opts?.source || 'tool'
    const idPrefix = source === 'git' ? 'git-diff:' : 'diff:'
    const existing = state.tabs.find(t => t.id === idPrefix + filePath || (t.type === 'diff' && t.filePath === filePath && t.id.startsWith(idPrefix)))
    if (existing) {
      existing.fileChange = { ...change }
      existing.title = title || existing.title
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const fileName = filePath.split(/[/\\]/).pop() || filePath
    const tabTitle = title || (source === 'git' ? `${fileName} (Git)` : `${fileName} (变更)`)
    const id = idPrefix + filePath
    const newTab: Tab = { id, type: 'diff', title: tabTitle, filePath, fileChange: { ...change } }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  function findSubagentTab(state: SessionTabState, childSessionId: number) {
    const id = 'subagent:' + childSessionId
    return state.tabs.find(t =>
      t.type === 'subagent' && (t.id === id || t.sideSessionId === childSessionId)
    )
  }

  /**
   * 打开边路任务 Tab。如果已存在则直接激活。
   * 传入 sideSessionId=0 表示"待创建"状态。
   * 占位 Tab 的 id 可能是 side:-{timestamp}，需按 sideSessionId 字段匹配。
   * opts 为创建入口预置的上下文继承方式与分叉来源，只对**还没发出首条消息的占位 Tab** 生效：
   * 复用占位 Tab 时整体覆写，把上一次入口留下的 fork / summary 残留清掉。
   * 已是真实会话的 Tab 只激活——那里 contextMode 早已用完，forkFrom 是纯展示字段，
   * 覆写会把分叉来源（Tab hover）清掉。
   */
  function openSideTaskTab(sideSessionId: number, title: string, opts: SideTaskEntryOptions = {}) {
    const state = getSessionState()
    const existing = findSideTaskTab(state, sideSessionId)
    if (existing) {
      if (existing.sideSessionId == null || existing.sideSessionId <= 0) {
        // 复用已存在的占位 Tab：整体覆写预置，避免半更新状态
        existing.contextMode = opts.contextMode ?? 'none'
        existing.forkFrom = opts.fork ?? undefined
        existing.sourceSessionId = opts.sourceSessionId
      }
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const id = 'side:' + sideSessionId
    const newTab: Tab = {
      id, type: 'side_task', title: normalizeSideTaskTitle(title), sideSessionId,
      contextMode: opts.contextMode ?? 'none',
      ...(opts.fork ? { forkFrom: opts.fork } : {}),
      ...(opts.sourceSessionId != null ? { sourceSessionId: opts.sourceSessionId } : {}),
    }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 原子覆写边路任务 Tab 的分叉预置（contextMode + 切点 + 来源会话）。fork 传 null 表示清除切点。
   * 三者描述同一次创建入口，一次写完，避免出现「contextMode 是 fork 但没有切点」
   * 或「上次来源残留到本次新建」的半更新状态。
   */
  function setSideTaskFork(tabId: string, opts: SideTaskEntryOptions) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === tabId)
    if (!tab || tab.type !== 'side_task') return
    tab.contextMode = opts.contextMode ?? 'none'
    tab.forkFrom = opts.fork ?? undefined
    tab.sourceSessionId = opts.sourceSessionId
    notifyTabsChanged()
  }

  /**
   * 打开轨迹 Tab（run 轨迹透视）。每会话单例（id = 'trace'），已存在则直接激活。
   * sid 缺省用当前会话；刷新还原入口传显式 sid（currentSessionId 可能尚未同步）。
   * 刷新还原依赖它：持久化类型是 trace 时，restoreActiveTab 只按 id 在已有 tabs 里找，
   * 不先建出来就永远留在主会话。
   */
  function openTraceTab(sid?: string) {
    const state = getSessionState(sid)
    const existing = state.tabs.find(t => t.type === 'trace')
    if (existing) {
      state.activeTabId = existing.id
    } else {
      state.tabs.push({ id: 'trace', type: 'trace', title: '轨迹' })
      state.activeTabId = 'trace'
    }
    notifyTabsChanged(sid)
  }

  /**
   * 打开子代理只读 Tab。如果已存在则直接激活。
   */
  function openSubagentTab(childSessionId: number, title: string) {
    if (childSessionId <= 0) return
    const state = getSessionState()
    const existing = findSubagentTab(state, childSessionId)
    if (existing) {
      existing.title = title || existing.title
      state.activeTabId = existing.id
      notifyTabsChanged()
      return
    }
    const id = 'subagent:' + childSessionId
    const newTab: Tab = {
      id,
      type: 'subagent',
      title: title || '子代理',
      sideSessionId: childSessionId,
    }
    state.tabs.push(newTab)
    state.activeTabId = id
    notifyTabsChanged()
  }

  /**
   * 更新边路任务 Tab（收到 side_session_created 后更新属性）。
   * 不改变 tab.id，保持组件不重新挂载。
   * oldId 可为占位 tab.id，也可传 side:{realId}；后者会按 sideSessionId 回退查找。
   */
  function updateSideTaskTab(oldId: string, sideSessionId: number, title: string) {
    const state = getSessionState()
    const tab = state.tabs.find(t => t.id === oldId)
      || (sideSessionId > 0 ? findSideTaskTab(state, sideSessionId) : undefined)
    if (tab) {
      // Don't change tab.id — keep the component mounted
      if (sideSessionId > 0) {
        tab.sideSessionId = sideSessionId
        // 来源会话预置随创建完成作废（与 contextMode 用完即弃一致）
        tab.sourceSessionId = undefined
      }
      tab.title = normalizeSideTaskTitle(title)
      notifyTabsChanged()
    }
  }

  function applyWorkspacePathChange(change: WorkspacePathChange) {
    const state = getSessionState()
    const closing: string[] = []
    for (const tab of state.tabs) {
      if ((tab.type !== 'file' && tab.type !== 'diff') || !tab.filePath) continue
      const next = retargetTabPath(tab.filePath, change)
      if (next.action === 'keep') continue
      if (next.action === 'close') {
        closing.push(tab.id)
        continue
      }
      const oldId = tab.id
      const fileName = next.path.split('/').pop() || next.path
      const prefix = oldId.startsWith('git-diff:') ? 'git-diff:' : oldId.startsWith('diff:') ? 'diff:' : 'file:'
      tab.filePath = next.path
      tab.id = prefix + next.path
      if (tab.type === 'file') {
        tab.title = fileName
        tab.version = (tab.version ?? 0) + 1
      } else {
        tab.title = prefix === 'git-diff:' ? `${fileName} (Git)` : `${fileName} (变更)`
        if (tab.fileChange) tab.fileChange = { ...tab.fileChange, path: next.path }
      }
      if (state.activeTabId === oldId) state.activeTabId = tab.id
    }
    if (closing.length === 0) {
      notifyTabsChanged()
      return
    }
    for (const id of closing) closeTab(id)
  }

  function closeTab(tabId: string) {
    if (tabId === 'chat') return // can't close chat tab
    const state = getSessionState()
    const idx = state.tabs.findIndex(t => t.id === tabId)
    if (idx === -1) return

    const tab = state.tabs[idx]
    if (tab.type === 'side_task' && tab.sideSessionId && tab.sideSessionId > 0) {
      markSideTaskClosed(currentSessionId.value, tab.sideSessionId)
    }

    state.tabs.splice(idx, 1)

    // If closing the active tab, switch to adjacent or chat
    if (state.activeTabId === tabId) {
      if (state.tabs.length > 0) {
        const newIdx = Math.min(idx, state.tabs.length - 1)
        state.activeTabId = state.tabs[newIdx].id
      } else {
        state.activeTabId = 'chat'
      }
    }
    notifyTabsChanged()
  }

  /**
   * 从后端恢复未关闭的边路任务 Tab（页面刷新后调用）。
   */
  function restoreSideTaskTabs(parentSessionId: string, sideTasks: SideTaskSummary[]) {
    if (!parentSessionId || sideTasks.length === 0) return
    const closed = getClosedSideTaskIds(parentSessionId)
    const state = sessionTabsMap.value.get(parentSessionId) ?? { tabs: [], activeTabId: 'chat' }
    let changed = false

    for (const st of sideTasks) {
      if (closed.has(st.id)) continue
      const id = 'side:' + st.id
      const existing = state.tabs.find(t => t.id === id || t.sideSessionId === st.id)
      if (existing) {
        existing.sideSessionId = st.id
        existing.title = normalizeSideTaskTitle(st.title)
        changed = true
        continue
      }
      const newTab: Tab = { id, type: 'side_task', title: normalizeSideTaskTitle(st.title), sideSessionId: st.id }
      state.tabs.push(newTab)
      changed = true
    }

    if (changed) {
      sessionTabsMap.value.set(parentSessionId, state)
      // 只是补齐 Tab 数据，不动激活态：不落盘（见 notifyTabsChanged 说明）
      notifyTabsChanged(parentSessionId, true)
    }
  }

  /**
   * 恢复子代理 Tab（不自动打开全部，仅补齐已在 tabs 中的标题；列表点击再 openSubagentTab）。
   * 若传入 openAll=true，则为每个子代理打开 Tab（默认 false，避免刷新刷屏）。
   */
  function restoreSubagentTabs(
    parentSessionId: string,
    subagents: Array<{ id: number; title: string }>,
    opts?: { openAll?: boolean }
  ) {
    if (!parentSessionId || subagents.length === 0) return
    if (!opts?.openAll) return
    const state = sessionTabsMap.value.get(parentSessionId) ?? { tabs: [], activeTabId: 'chat' }
    let changed = false
    for (const sa of subagents) {
      const id = 'subagent:' + sa.id
      const existing = state.tabs.find(t => t.type === 'subagent' && (t.id === id || t.sideSessionId === sa.id))
      if (existing) {
        existing.sideSessionId = sa.id
        existing.title = sa.title || existing.title
        changed = true
        continue
      }
      state.tabs.push({
        id,
        type: 'subagent',
        title: sa.title || '子代理',
        sideSessionId: sa.id,
      })
      changed = true
    }
    if (changed) {
      sessionTabsMap.value.set(parentSessionId, state)
      // 只是补齐 Tab 数据，不动激活态：不落盘（见 notifyTabsChanged 说明）
      notifyTabsChanged(parentSessionId, true)
    }
  }

  /**
   * 按持久化的激活态还原 Tab（页面刷新 / 冷启动后调用）。
   *
   * 直接用显式 parentSessionId 而非模块级 currentSessionId：调用方（TaskView.loadSession）
   * 在 setActiveSession 之后同步调用本函数，而 currentSessionId 靠 watch 异步同步，
   * 此刻往往还是上一个会话（或空）——依赖它会读错会话的 Tab 状态。
   * 只在该会话当前停在 chat 时生效——避免覆盖用户本次会话内的主动切换。
   * 边路任务 / 子代理按 sideSessionId 匹配（tab id 可能是占位 id），文件类按 id 匹配；
   * 目标 Tab 尚未恢复出来时保持 chat。
   */
  function restoreActiveTab(parentSessionId: string): void {
    const sid = String(parentSessionId || '')
    if (!sid) return
    const persisted = getPersistedActiveTab(sid)
    if (!persisted) return
    const state = sessionTabsMap.value.get(sid)
    if (!state) return
    if ((state.activeTabId || 'chat') !== 'chat') return
    const target = persisted.sideSessionId != null
      ? state.tabs.find(t => (t.type === 'side_task' || t.type === 'subagent') && t.sideSessionId === persisted.sideSessionId)
      : persisted.tabId
        ? state.tabs.find(t => t.id === persisted.tabId)
        : undefined
    if (!target) return
    state.activeTabId = target.id
    // 显式带 sid：currentSessionId 可能还没同步到 sid（loadSession 中 setActiveSession
    // 之后紧接着同步调用本函数），不传会写到错误的会话 key 上。
    notifyTabsChanged(sid)
  }

  function activateTab(tabId: string) {
    const state = getSessionState()
    state.activeTabId = tabId
    notifyTabsChanged()
  }

  /**
   * 轨迹 tab 的刷新还原（loadSession 里调用，与边路任务还原相互独立）。
   *
   * restoreActiveTab 只在已有 state.tabs 里按 id 找，不会把轨迹 tab 建出来——
   * 不先 openTraceTab() 的话，上次停在轨迹 tab 的用户刷新后只会回到主会话。
   * 持久化类型不是 trace 时不插手，避免覆盖用户本次会话内的主动切换。
   */
  function restoreTraceTab(parentSessionId: string): void {
    const sid = String(parentSessionId || '')
    if (!sid) return
    if (getPersistedActiveTab(sid)?.type !== 'trace') return
    openTraceTab(sid)
    restoreActiveTab(sid)
  }

  /** 仅关闭文件类标签（file / diff），保留边路任务 / 子代理等非文件标签。 */
  function closeAllFileTabs() {
    const state = getSessionState()
    state.tabs = state.tabs.filter(t => t.type !== 'file' && t.type !== 'diff')
    if (state.activeTabId !== 'chat' && !state.tabs.some(t => t.id === state.activeTabId)) {
      state.activeTabId = state.tabs.length > 0 ? state.tabs[state.tabs.length - 1].id : 'chat'
    }
    notifyTabsChanged()
  }

  // 与菜单文案「关闭其他文件」对齐：只关文件/diff Tab，保留边路任务与子代理 Tab。
  // 早期实现是 state.tabs = [当前 tab]，会连带关掉边路任务，且漏掉 closeTab 里的
  // markSideTaskClosed 记账，导致用户关掉的边路 Tab 在 restoreSideTaskTabs 时又冒出来。
  function closeOtherTabs(tabId: string) {
    const state = getSessionState()
    state.tabs = state.tabs.filter(t => t.id === tabId || (t.type !== 'file' && t.type !== 'diff'))
    if (state.tabs.some(t => t.id === tabId)) {
      state.activeTabId = tabId
    } else if (state.activeTabId !== 'chat' && !state.tabs.some(t => t.id === state.activeTabId)) {
      // 在 chat Tab 上右键「关闭其他文件」：tabId 不在 state.tabs 里，回落到 chat
      state.activeTabId = 'chat'
    }
    notifyTabsChanged()
  }

  // Clean up tab state when session is deleted
  function removeSessionTabs(sessionId: string) {
    if (!sessionTabsMap.value.has(sessionId)) return
    sessionTabsMap.value.delete(sessionId)
    // Map 内部变更不会自动触发 computed，需要替换 Map 引用
    sessionTabsMap.value = new Map(sessionTabsMap.value)
  }

  return {
    tabs,
    activeTabId,
    activeTab,
    openFileTab,
    openDiffTab,
    openSideTaskTab,
    setSideTaskFork,
    openSubagentTab,
    openTraceTab,
    updateSideTaskTab,
    restoreSideTaskTabs,
    restoreSubagentTabs,
    restoreTraceTab,
    closeTab,
    applyWorkspacePathChange,
    closeAllFileTabs,
    closeOtherTabs,
    activateTab,
    restoreActiveTab,
    removeSessionTabs,
  }
}
