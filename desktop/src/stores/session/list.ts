import { computed, ref } from 'vue'
import { api } from '../../api'
import { useDraftStore } from '../draft'
import { cloudGroupKey } from '../../utils/cloud-project'
import { sortByFocusPriority, sessionToFocusCandidate } from '../../utils/focusSort'
import { normalizeId, normalizeSession, persistLastSession, LAST_SESSION_KEY, ACTIVE_PHASES, DEFAULT_GROUP_PREVIEW, DEFAULT_GROUP_PAGE_SIZE } from './types'
import type { Session, SessionEnvironmentInfo, SessionGroupMeta, CloudProject, TaskPhase } from './types'

/** 会话列表领域：实体缓存、标准/归档/聚焦投影、分组元数据、归档/删除/重命名。 */
export function createSessionListModule(ctx: {
  sessionPendingApprovals: () => { value: Map<string, number> }
  sessionPendingQuestions: () => { value: Map<string, any[]> }
  sessionContextWindow: () => { value: Map<string, { estimated: number; actual: number }> }
  ctxSessionPhases: () => { value: Map<string, TaskPhase> }
  viewingSideTaskId: { value: number | null }
  purgeSessionRuntime: (sid: string) => void
  reconcileSideTaskPendingCounts: (parentSessionId: string, approvalCount?: number, questionCount?: number) => void
  setCompacting: (sessionId: string, compacting: boolean) => void
  clearLlmRetry: (sessionId: string) => void
  setLlmRetry: (sessionId: string, info: any) => void
  setExecutionError: (sessionId: string, message: string) => void
}) {
  const { sessionPendingApprovals: getSessionPendingApprovals, sessionPendingQuestions: getSessionPendingQuestions, sessionContextWindow: getSessionContextWindow, ctxSessionPhases: getCtxSessionPhases, viewingSideTaskId, purgeSessionRuntime, reconcileSideTaskPendingCounts, setCompacting, clearLlmRetry, setLlmRetry, setExecutionError } = ctx

  /**
   * 会话实体缓存（唯一真相源）。所有字段变更只进这里。
   * 各列表投影（standard/archived/focus）只存 ID 数组，组件通过 ID 读实体。
   */
  const sessionEntities = ref<Map<string, Session>>(new Map())
  /** 标准模式分组视图投影：ID 顺序 = 服务端分组预览/分页追加顺序 */
  const standardSessionIds = ref<string[]>([])
  /** 已归档区投影 */
  const archivedSessionIds = ref<string[]>([])
  /** 聚焦模式全量 ACTIVE 主会话投影：成员集合 + 后端基础顺序（排序由 focusedSessions computed 动态派生） */
  const focusSessionIds = ref<string[]>([])

  /** 兼容旧读取点：标准模式列表 = 投影 ID → 实体（只读 computed） */
  const sessions = computed<Session[]>(() =>
    standardSessionIds.value
      .map(id => sessionEntities.value.get(id))
      .filter((s): s is Session => !!s)
  )
  /** 已归档列表（只读 computed） */
  const archivedSessions = computed<Session[]>(() =>
    archivedSessionIds.value
      .map(id => sessionEntities.value.get(id))
      .filter((s): s is Session => !!s)
  )
  /** 聚焦模式列表：投影成员 + 动态优先级排序（不手动维护 ID 顺序）。
   *  实时 pending 信号（WebSocket 增量）与服务端 tree* 取并集（max），
   *  保证主会话待审批 / 待回答在事件到达的瞬间即可升到优先级 0（无需等列表刷新）。 */
  const focusedSessions = computed<Session[]>(() => {
    const realtimeApproval = getSessionPendingApprovals().value
    const realtimeQuestions = getSessionPendingQuestions().value
    return sortByFocusPriority(
      focusSessionIds.value
        .map(id => sessionEntities.value.get(id))
        .filter((s): s is Session => !!s)
        .map(s => ({
          ...sessionToFocusCandidate(s),
          pendingApprovalCount: Math.max(
            s.treePendingApprovalCount ?? s.pendingApprovalCount ?? 0,
            realtimeApproval.get(String(s.id)) ?? 0
          ),
          pendingQuestionCount: Math.max(
            s.treePendingQuestionCount ?? s.pendingQuestionCount ?? 0,
            realtimeQuestions.get(String(s.id))?.length ?? 0
          ),
        }))
    )
      .map(c => sessionEntities.value.get(c.id))
      .filter((s): s is Session => !!s)
  })

  /** Per-group list metadata from /sessions/groups (and load-more). */
  const groupMeta = ref<Map<string, SessionGroupMeta>>(new Map())
  /** 已归档区分组元数据（数量徽标等） */
  const archivedGroupMeta = ref<Map<string, SessionGroupMeta>>(new Map())
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)
  const archivedLoading = ref(false)
  const focusLoading = ref(false)
  const loadingMoreGroups = ref<Set<string>>(new Set())
  /** 归档/恢复进行中的会话 id（防重复点击并发请求） */
  const archivingIds = ref<Set<string>>(new Set())
  /** 删除进行中的会话 id（防重复点击并发删除） */
  const deletingIds = ref<Set<string>>(new Set())
  /** 已归档区 / 聚焦数据是否已加载过（用于增量刷新与静默重拉判断） */
  const archivedLoaded = ref(false)
  const focusLoaded = ref(false)

  const activeSession = computed(() => {
    const id = activeSessionId.value
    if (!id) return null
    // 从实体缓存查找：归档当前会话后实体保留，activeSession 仍有效（聊天面板不受影响）
    return sessionEntities.value.get(id) || null
  })

  function sessionsByAgent(agentId: string) {
    return sessions.value.filter(s => s.agentId === agentId)
  }

  let fetchSessionsSeq = 0
  let fetchArchivedSeq = 0
  let fetchFocusSeq = 0

  async function fetchSessions(silent = false) {
    const seq = ++fetchSessionsSeq
    if (!silent) loading.value = true
    try {
      const { data } = await api.get('/sessions/groups', {
        params: { previewLimit: DEFAULT_GROUP_PREVIEW }
      })
      if (seq !== fetchSessionsSeq) return
      const groups: any[] = data?.groups || []
      const ids: string[] = []
      const meta = new Map<string, SessionGroupMeta>()
      for (const g of groups) {
        const key = String(g.key)
        const sessions: Session[] = (g.sessions || []).map(normalizeSession)
        meta.set(key, {
          label: g.label || key,
          total: Number(g.total) || 0,
          hasMore: !!g.hasMore,
          loadedCount: sessions.length
        })
        for (const normalized of sessions) {
          // unread 以服务端为准（服务端 DB 是未读持久化权威；本地已读仅在 markAsRead API 成功后清除）
          upsertSessionEntity(normalized)
          applyRuntimeStatus(normalized)
          // 列表 VO 的聚合计数来自请求时刻的服务端注册表：为 0 时同步清掉边路缓存的残留计数
          reconcileSideTaskPendingCounts(
            String(normalized.id),
            normalized.treePendingApprovalCount,
            normalized.treePendingQuestionCount
          )
          ids.push(String(normalized.id))
        }
      }
      // 刷新即重置为分组预览（丢弃先前 load-more 追加的页）
      standardSessionIds.value = ids
      groupMeta.value = meta

      for (const id of ids) {
        const s = sessionEntities.value.get(id)
        if (s && s.contextTokens && s.contextTokens > 0) {
          const sid = String(s.id)
          if (!getSessionContextWindow().value.has(sid)) {
            getSessionContextWindow().value.set(sid, { estimated: s.contextTokens, actual: 0 })
          }
        }
      }
    } finally {
      if (seq === fetchSessionsSeq) loading.value = false
    }
  }

  async function loadMoreInGroup(groupKey: string, limit = DEFAULT_GROUP_PAGE_SIZE): Promise<boolean> {
    const key = String(groupKey)
    if (loadingMoreGroups.value.has(key)) return false
    const meta = groupMeta.value.get(key)
    if (meta && !meta.hasMore) return false

    // offset 必须以「服务端该分组已返回条数」为准，不能从本地投影反推：
    // 深链注入（updateSession）会把预览外的会话 unshift 进投影，使 offset 偏大漏会话。
    const offset = meta?.loadedCount ?? 0
    loadingMoreGroups.value = new Set(loadingMoreGroups.value).add(key)
    try {
      const { data } = await api.get('/sessions', {
        params: { groupKey: key, offset, limit }
      })
      const items: Session[] = (data?.items || []).map(normalizeSession)
      if (items.length === 0) {
        if (meta) {
          groupMeta.value.set(key, { ...meta, hasMore: false, loadedCount: offset })
          groupMeta.value = new Map(groupMeta.value)
        }
        return false
      }

      const existingIds = new Set(standardSessionIds.value)
      const appended = items.filter(s => !existingIds.has(String(s.id)))
      const appendedIds: string[] = []
      for (const s of appended) {
        upsertSessionEntity(s)
        applyRuntimeStatus(s)
        appendedIds.push(String(s.id))
      }
      if (appendedIds.length > 0) {
        standardSessionIds.value = [...standardSessionIds.value, ...appendedIds]
      }

      const serverTotal = data?.total
      const nextMeta: SessionGroupMeta = {
        label: meta?.label || key,
        total: serverTotal != null ? Number(serverTotal) : (meta?.total ?? (meta?.loadedCount ?? 0) + items.length),
        hasMore: !!data?.hasMore,
        // 以服务端本页返回条数推进，即使其中部分已因深链注入在本地存在
        loadedCount: offset + items.length
      }
      groupMeta.value.set(key, nextMeta)
      groupMeta.value = new Map(groupMeta.value)
      return appendedIds.length > 0 || !!data?.hasMore
    } finally {
      const next = new Set(loadingMoreGroups.value)
      next.delete(key)
      loadingMoreGroups.value = next
    }
  }

  function getGroupMeta(groupKey: string): SessionGroupMeta | undefined {
    return groupMeta.value.get(String(groupKey))
  }

  function isGroupLoadingMore(groupKey: string): boolean {
    return loadingMoreGroups.value.has(String(groupKey))
  }

  function bumpGroupMetaForSession(session: Session, delta: number) {
    const key = cloudGroupKey(session)
    const existing = groupMeta.value.get(key)
    if (existing) {
      groupMeta.value.set(key, {
        ...existing,
        total: Math.max(0, existing.total + delta)
      })
    } else if (delta > 0) {
      groupMeta.value.set(key, { label: key, total: 1, hasMore: false })
    }
    groupMeta.value = new Map(groupMeta.value)
  }

  // --- 实体 / 投影模型 ---

  /** 唯一原子更新入口：只写实体，不自动加入任何查询投影（避免污染标准分页等）。 */
  function upsertSessionEntity(session: Session) {
    const sid = String(session.id)
    const normalized = normalizeSession(session)
    normalized.id = sid
    if (session.agentId != null) normalized.agentId = normalizeId(session.agentId)
    sessionEntities.value.set(sid, normalized)
    sessionEntities.value = new Map(sessionEntities.value)
  }

  /** 按 id 读取会话实体（不存在返回 undefined）。 */
  function getSessionEntity(id: string): Session | undefined {
    return sessionEntities.value.get(String(id))
  }

  /** 服务端 session_tree_status 事件：更新父任务实体的任务树聚合信号（聚焦模式实时重排）。 */
  function updateSessionTreeSignals(parentSessionId: string, signals: {
    treePendingApprovalCount?: number
    treePendingQuestionCount?: number
    treeUnread?: boolean
    treeRunning?: boolean
    treeFailed?: boolean
  }) {
    const sid = String(parentSessionId)
    const entity = sessionEntities.value.get(sid)
    if (!entity) return
    upsertSessionEntity({
      ...entity,
      ...(signals.treePendingApprovalCount != null ? { treePendingApprovalCount: signals.treePendingApprovalCount } : {}),
      ...(signals.treePendingQuestionCount != null ? { treePendingQuestionCount: signals.treePendingQuestionCount } : {}),
      ...(signals.treeUnread != null ? { treeUnread: signals.treeUnread } : {}),
      ...(signals.treeRunning != null ? { treeRunning: signals.treeRunning } : {}),
      ...(signals.treeFailed != null ? { treeFailed: signals.treeFailed } : {}),
    })
    reconcileSideTaskPendingCounts(sid, signals.treePendingApprovalCount, signals.treePendingQuestionCount)
  }

  function isArchiving(id: string): boolean {
    return archivingIds.value.has(String(id))
  }

  /** 归档：API 成功后再移动本地（失败不预移除）；归档当前会话不清空 activeSessionId。 */
  async function archiveSession(id: string) {
    const sid = String(id)
    if (archivingIds.value.has(sid)) return
    archivingIds.value = new Set(archivingIds.value).add(sid)
    try {
      await api.put(`/sessions/${sid}/archive`)
      const entity = sessionEntities.value.get(sid)
      if (entity) {
        upsertSessionEntity({ ...entity, status: 'ARCHIVED' })
        bumpGroupMetaForSession(entity, -1)
      }
      // ACTIVE → ARCHIVED：从标准/聚焦投影移除，加入已归档投影
      standardSessionIds.value = standardSessionIds.value.filter(x => x !== sid)
      focusSessionIds.value = focusSessionIds.value.filter(x => x !== sid)
      if (!archivedSessionIds.value.includes(sid)) {
        archivedSessionIds.value = [sid, ...archivedSessionIds.value]
      }
      // 已归档区已加载过 → 静默刷新以同步服务端顺序与数量
      if (archivedLoaded.value) {
        await fetchArchivedSessions(true)
      }
    } catch {
      // API 失败：本地不动，等待下次拉取同步
    } finally {
      const next = new Set(archivingIds.value)
      next.delete(sid)
      archivingIds.value = next
    }
  }

  /** 恢复归档：API 成功后再移动本地，并静默刷新标准分组接口（服务端排序决定插入位置）。 */
  async function unarchiveSession(id: string) {
    const sid = String(id)
    if (archivingIds.value.has(sid)) return
    archivingIds.value = new Set(archivingIds.value).add(sid)
    try {
      await api.put(`/sessions/${sid}/unarchive`)
      const entity = sessionEntities.value.get(sid)
      if (entity) {
        upsertSessionEntity({ ...entity, status: 'ACTIVE' })
      }
      // ARCHIVED → ACTIVE：从已归档投影移除；focus 已加载则加入聚焦投影
      archivedSessionIds.value = archivedSessionIds.value.filter(x => x !== sid)
      if (focusLoaded.value && !focusSessionIds.value.includes(sid)) {
        focusSessionIds.value = [sid, ...focusSessionIds.value]
      }
      // 恢复后静默刷新标准分组接口（服务端排序 + groupMeta 自动修正）
      await fetchSessions(true)
      if (archivedLoaded.value) {
        await fetchArchivedSessions(true)
      }
    } catch {
      // API 失败：本地不动
    } finally {
      const next = new Set(archivingIds.value)
      next.delete(sid)
      archivingIds.value = next
    }
  }

  /** 已归档区分组列表（status=ARCHIVED）。 */
  async function fetchArchivedSessions(silent = false) {
    const seq = ++fetchArchivedSeq
    if (!silent) archivedLoading.value = true
    try {
      const { data } = await api.get('/sessions/groups', {
        params: { previewLimit: 50, status: 'ARCHIVED' }
      })
      if (seq !== fetchArchivedSeq) return
      const groups: any[] = data?.groups || []
      const ids: string[] = []
      const meta = new Map<string, SessionGroupMeta>()
      for (const g of groups) {
        const key = String(g.key)
        const sessions: Session[] = (g.sessions || []).map(normalizeSession)
        meta.set(key, {
          label: g.label || key,
          total: Number(g.total) || 0,
          hasMore: !!g.hasMore,
          loadedCount: sessions.length
        })
        for (const normalized of sessions) {
          upsertSessionEntity(normalized)
          applyRuntimeStatus(normalized)
          ids.push(String(normalized.id))
        }
      }
      archivedSessionIds.value = ids
      archivedGroupMeta.value = meta
      archivedLoaded.value = true
    } finally {
      if (seq === fetchArchivedSeq) archivedLoading.value = false
    }
  }

  /** 聚焦模式全量 ACTIVE 主会话（不带 groupKey）。 */
  async function fetchFocusSessions(silent = false) {
    const seq = ++fetchFocusSeq
    if (!silent) focusLoading.value = true
    try {
      const { data } = await api.get('/sessions', {
        params: { status: 'ACTIVE' }
      })
      if (seq !== fetchFocusSeq) return
      const items: Session[] = Array.isArray(data) ? data.map(normalizeSession) : []
      const ids: string[] = []
      for (const s of items) {
        upsertSessionEntity(s)
        applyRuntimeStatus(s)
        ids.push(String(s.id))
      }
      focusSessionIds.value = ids
      focusLoaded.value = true
    } finally {
      if (seq === fetchFocusSeq) focusLoading.value = false
    }
  }

  async function fetchSession(id: string) {
    try {
      const { data } = await api.get(`/sessions/${id}`)
      if (data) {
        const local = sessionEntities.value.get(String(id))
        const normalized = normalizeSession({ ...data, unread: local?.unread ?? data.unread })
        updateSession(id, normalized)
        applyRuntimeStatus(normalized)
        if (data.contextTokens && data.contextTokens > 0) {
          const sid = normalizeId(data.id)
          if (!getSessionContextWindow().value.has(sid)) {
            getSessionContextWindow().value.set(sid, { estimated: data.contextTokens, actual: 0 })
          }
        }
      }
      return data
    } catch {
      return null
    }
  }

  async function createSession(
    agentId: string,
    executionMode: string,
    workspace?: string,
    environmentInfo?: SessionEnvironmentInfo,
    modelId?: number,
    permissionLevel?: string,
    cloudProjectKey?: string,
    workspaceMode?: string,
    gitCloneUrl?: string,
    gitBranch?: string
  ) {
    const payload: Record<string, unknown> = {
      agentId,
      executionMode,
      modelId: modelId || undefined,
      permissionLevel: permissionLevel || undefined,
      isGit: environmentInfo?.isGit,
      platform: environmentInfo?.platform,
      shell: environmentInfo?.shell,
      osVersion: environmentInfo?.osVersion
    }
    if (executionMode === 'LOCAL') {
      payload.workspace = workspace || undefined
    } else if (executionMode === 'CLOUD') {
      payload.workspaceMode = workspaceMode || 'new'
      if (workspaceMode === 'git' && gitCloneUrl) {
        payload.gitCloneUrl = gitCloneUrl
        if (gitBranch) payload.gitBranch = gitBranch
      } else if (cloudProjectKey) {
        payload.cloudProjectKey = cloudProjectKey
      }
    }
    const { data } = await api.post('/sessions', payload, {
      timeout: workspaceMode === 'git' ? 150_000 : undefined,
    })
    if (data) {
      data.id = normalizeId(data.id)
      data.agentId = normalizeId(data.agentId)
      upsertSessionEntity(data)
      const sid = String(data.id)
      if (!standardSessionIds.value.includes(sid)) {
        standardSessionIds.value = [sid, ...standardSessionIds.value]
      }
      if (focusLoaded.value && !focusSessionIds.value.includes(sid)) {
        focusSessionIds.value = [sid, ...focusSessionIds.value]
      }
      bumpGroupMetaForSession(data, 1)
    }
    return data
  }

  async function fetchCloudProjects(): Promise<CloudProject[]> {
    try {
      const { data } = await api.get('/sessions/cloud-projects')
      return (data || []) as CloudProject[]
    } catch {
      return []
    }
  }

  function setActiveSession(id: string | null) {
    activeSessionId.value = id
    persistLastSession(id)
  }

  /** 读取持久化的最后查看会话 ID（存储不可用时返回 null）。 */
  function getLastSessionId(): string | null {
    try {
      return localStorage.getItem(LAST_SESSION_KEY)
    } catch {
      return null
    }
  }

  /** 清除持久化的最后查看会话 ID（会话已删除/失效时调用）。 */
  function forgetLastSession() {
    persistLastSession(null)
  }

  function updateSession(id: string, updates: Partial<Session>) {
    const sid = String(id)
    const existing = sessionEntities.value.get(sid)
    const next = normalizeSession({ ...(existing ?? { id: sid }), ...updates, id: sid })
    if (updates.agentId != null) {
      next.agentId = normalizeId(updates.agentId)
    }
    upsertSessionEntity(next)
    if (!existing && updates.executionMode && next.status !== 'ARCHIVED') {
      // Deep-link / loadSession for a session outside the current group preview：
      // 写入标准投影头部（原有行为），并登记分组元数据。已归档会话不进 ACTIVE 投影。
      if (!standardSessionIds.value.includes(sid)) {
        standardSessionIds.value = [sid, ...standardSessionIds.value]
      }
      const key = cloudGroupKey(next)
      if (!groupMeta.value.has(key)) {
        // 服务端列表尚未为该分组分页过；注入的这条不计入 loadedCount
        groupMeta.value.set(key, { label: key, total: 1, hasMore: false, loadedCount: 0 })
        groupMeta.value = new Map(groupMeta.value)
      }
    }
  }

  function updateSessionPhase(id: string, phase: TaskPhase, startedAt?: string) {
    getCtxSessionPhases().value.set(String(id), phase)
    updateSession(id, {
      phase,
      running: ACTIVE_PHASES.has(phase),
      ...(startedAt ? { startedAt } : {})
    })
  }

  /** 合并请求期间可能已被 WS 更新的会话快照，避免迟到的 REST 响应覆盖实时 phase。 */
  function updateSessionFromSnapshot(id: string, snapshot: Partial<Session>, phaseAtRequest?: TaskPhase) {
    const sid = String(id)
    const current = sessionEntities.value.get(sid)
    const livePhase = getCtxSessionPhases().value.get(sid)
    const phaseChangedWhileFetching = phaseAtRequest !== undefined
      && current?.phase !== undefined
      && current.phase !== phaseAtRequest
    if (livePhase || phaseChangedWhileFetching) {
      const phase = livePhase ?? current!.phase
      updateSession(id, { ...snapshot, phase, running: ACTIVE_PHASES.has(phase) })
      return
    }
    updateSession(id, snapshot)
  }

  function getSessionPhase(id: string): TaskPhase | null {
    const sid = String(id)
    const cached = getCtxSessionPhases().value.get(sid)
    if (cached) return cached
    const session = sessions.value.find(s => String(s.id) === sid)
    return session?.phase ?? null
  }

  async function renameSession(id: string, title: string) {
    const { data } = await api.patch(`/sessions/${id}`, { title })
    if (data) {
      updateSession(id, { title: data.title, summary: data.summary })
    }
  }

  async function updateSessionModel(id: string, modelId: number) {
    const { data } = await api.patch(`/sessions/${id}`, { modelId })
    if (data) {
      updateSession(id, {
        modelId: data.modelId,
        modelName: data.modelName,
        modelSupportsVision: data.modelSupportsVision
      })
    }
  }

  function isDeleting(id: string): boolean {
    return deletingIds.value.has(String(id))
  }

  async function deleteSession(id: string): Promise<boolean> {
    const sid = String(id)
    if (deletingIds.value.has(sid)) return false
    deletingIds.value = new Set(deletingIds.value).add(sid)
    try {
      const existing = sessionEntities.value.get(sid)
      await api.delete(`/sessions/${id}`)
      standardSessionIds.value = standardSessionIds.value.filter(x => x !== sid)
      archivedSessionIds.value = archivedSessionIds.value.filter(x => x !== sid)
      focusSessionIds.value = focusSessionIds.value.filter(x => x !== sid)
      sessionEntities.value.delete(sid)
      sessionEntities.value = new Map(sessionEntities.value)
      if (existing) {
        bumpGroupMetaForSession(existing, -1)
      }
      if (activeSessionId.value === sid) {
        activeSessionId.value = null
      }
      // 若删除的是持久化的最后查看会话，一并清除，避免下次冷启动恢复一个已删除会话
      if (getLastSessionId() === sid) {
        forgetLastSession()
      }
      // Clean up cached data
      purgeSessionRuntime(sid)
      if (viewingSideTaskId.value === Number(id)) {
        viewingSideTaskId.value = null
      }
      useDraftStore().clearDraftAndMark(`s:${sid}`)
      return true
    } catch {
      // 拦截器已提示失败；返回 false 供调用方停止后续跳转，避免删除失败仍表现为成功
      return false
    } finally {
      const next = new Set(deletingIds.value)
      next.delete(sid)
      deletingIds.value = next
    }
  }

  async function markAsRead(sessionId: string) {
    // 服务端 DB 是未读持久化权威：API 成功后再清本地；失败保留本地未读（下次拉取同步）
    try {
      await api.put(`/sessions/${sessionId}/read`)
      const entity = sessionEntities.value.get(String(sessionId))
      if (entity && entity.unread) {
        upsertSessionEntity({ ...entity, unread: false })
      }
    } catch {
      // Silent fail — next fetchSessions will sync
    }
  }

  function applyRuntimeStatus(session: Session) {
    const sid = String(session.id)
    const status = session.runtimeStatus
    if (!session.running || !status) {
      setCompacting(sid, false)
      clearLlmRetry(sid)
      // FAILED 且 runtimeStatus 中持久化了 executionError 时恢复错误状态
      if (session.phase === 'FAILED' && status?.executionError) {
        setExecutionError(sid, status.executionError)
      }
      return
    }
    setCompacting(sid, Boolean(status.compacting))
    if (status.llmRetry) {
      setLlmRetry(sid, status.llmRetry)
    } else if (status.llmWaiting) {
      setLlmRetry(sid, status.llmWaiting)
    } else {
      clearLlmRetry(sid)
    }
  }

  function reset() {
    sessionEntities.value = new Map()
    standardSessionIds.value = []
    archivedSessionIds.value = []
    focusSessionIds.value = []
    groupMeta.value = new Map()
    archivedGroupMeta.value = new Map()
    archivedLoaded.value = false
    focusLoaded.value = false
    archivingIds.value = new Set()
    deletingIds.value = new Set()
    loadingMoreGroups.value = new Set()
    activeSessionId.value = null
    loading.value = false
    archivedLoading.value = false
    focusLoading.value = false
    // 登出/换号：清掉持久化的最后查看会话，避免 B 账号冷启动去 fetch A 的会话
    forgetLastSession()
  }

  return {
    // state
    sessionEntities,
    standardSessionIds,
    archivedSessionIds,
    focusSessionIds,
    groupMeta,
    archivedGroupMeta,
    activeSessionId,
    loading,
    archivedLoading,
    focusLoading,
    loadingMoreGroups,
    archivingIds,
    deletingIds,
    archivedLoaded,
    focusLoaded,
    // computed
    sessions,
    archivedSessions,
    focusedSessions,
    activeSession,
    // actions
    sessionsByAgent,
    fetchSessions,
    loadMoreInGroup,
    getGroupMeta,
    isGroupLoadingMore,
    upsertSessionEntity,
    getSessionEntity,
    updateSessionTreeSignals,
    isArchiving,
    isDeleting,
    archiveSession,
    unarchiveSession,
    fetchArchivedSessions,
    fetchFocusSessions,
    fetchSession,
    createSession,
    fetchCloudProjects,
    setActiveSession,
    getLastSessionId,
    forgetLastSession,
    updateSession,
    updateSessionPhase,
    updateSessionFromSnapshot,
    getSessionPhase,
    renameSession,
    updateSessionModel,
    deleteSession,
    markAsRead,
    applyRuntimeStatus,
    bumpGroupMetaForSession,
    reset,
  }
}
