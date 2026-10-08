import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { javaLocalDateTimeString, nowSql } from '../common/datetime.js';
import { collectEntityIds, parseEntityId } from '../common/request.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import { MessageHistoryNormalizer, MISSING_TOOL_RESULT_PLACEHOLDER } from '../harness/core/message-history-normalizer.js';
import { CloudWorkspaceResolver } from '../harness/safety/cloud-workspace-resolver.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import { fromString as permissionFromString } from './permission-level.js';
import { isFeishuChannelSession } from '../harness/tool/feishu-channel-tool.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';
import { FileChangeRepository, MessageRepository, SessionRepository, type SessionListFilter, type SessionSource } from './session.repository.js';
import { SessionTodoRepository } from './activity.repository.js';
import type {
  AgentLookup,
  AgentRef,
  ContextAnchor,
  FileChange,
  Message,
  MessagePage,
  MessageSearchItem,
  Session,
  SessionGroupBucket,
  SessionGroupPage,
  SessionTodo,
  UserCommandLookup,
} from './types.js';
import { SessionGroupKey } from './util/session-group-key.js';
import { GitUrlParser } from './util/git-url-parser.js';
import { toStoredContentJson } from './session-vo.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';

const SEARCH_RESULT_LIMIT = 20;
const SEARCH_KEYWORD_MAX_LENGTH = 100;
const SNIPPET_CONTEXT_CHARS = 25;
const SNIPPET_MAX_LENGTH = 80;
/** 写入会话工作区的 runtime 临时目录/文件前缀，会话删除时一并清理。 */
const RUNTIME_WORKSPACE_PREFIX = 'mao-runtime-';

export class SessionService {
  static readonly SEARCH_RESULT_LIMIT = SEARCH_RESULT_LIMIT;

  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly messageRepo: MessageRepository,
    private readonly fileChangeRepo: FileChangeRepository,
    private readonly agentLookup: AgentLookup,
    private readonly pathSandbox: PathSandbox,
    private readonly environmentInfoProvider: EnvironmentInfoProvider,
    _userCommandService: UserCommandLookup,
    private readonly gitOperationService: GitOperationService,
    private readonly sessionCompactionService: SessionCompactionService,
    private readonly sessionCompactionEventService: SessionCompactionEventService,
    private readonly todoRepo?: SessionTodoRepository,
    /** 会话删除时清理 runtime 目录（含上传的 incoming 文件）的回调，可选。 */
    private readonly cleanupRuntimeDir?: (userId: number, sessionId: number) => void,
    /** 会话删除时关闭其全部云端终端的回调，可选。 */
    private readonly closeSessionTerminals?: (sessionId: number) => void,
    /** 会话删除后清理绑定资源（如定时任务）。失败只记日志，不回滚已删除的会话。 */
    private readonly onSessionDeleted?: (sessionId: number) => Promise<void> | void,
    /** 会话删除时物理删其会话级审批放行规则（V135 级联）。 */
    private readonly deleteSessionApprovalRules?: (sessionId: number) => Promise<void>,
  ) {}

  async createSession(
    userId: number,
    agentId: number | null | undefined,
    title: string | null | undefined,
    executionMode?: string | null,
    workspace?: string | null,
    permissionLevel?: string | null,
    isGit?: boolean | null,
    platform?: string | null,
    shellPath?: string | null,
    osVersion?: string | null,
    modelId?: number | null,
    cloudProjectKey?: string | null,
    workspaceMode?: string | null,
    gitCloneUrl?: string | null,
    gitBranch?: string | null,
    source?: SessionSource | null,
  ): Promise<Session> {
    let resolvedAgentId = parseEntityId(agentId);
    if (resolvedAgentId == null) {
      resolvedAgentId = (await this.agentLookup.requireDefaultAgent()).id;
    }
    const agent = await this.agentLookup.findById(resolvedAgentId);
    if (agent == null) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用');
    }

    const session: Session = {
      userId,
      agentId: resolvedAgentId,
      title: title != null ? title : '未命名会话',
      status: 'ACTIVE',
      executionMode: executionMode != null ? executionMode : 'CLOUD',
      permissionLevel: permissionLevel != null ? permissionLevel : 'READ_ONLY',
      isGit: isGit ?? null,
      platform: platform ?? null,
      shellPath: shellPath ?? null,
      osVersion: osVersion ?? null,
      modelId: parseEntityId(modelId),
      isPinned: 0,
      isFavorite: 0,
      phase: 'IDLE',
      elapsedMs: 0,
      sessionType: 'NORMAL',
      source: source ?? 'web',
    };

    if (session.executionMode === 'CLOUD') {
      if (workspace != null && workspace.length > 0) {
        session.workspace = workspace;
        // 显式 cloudProjectKey（如飞书通道 feishu-{botId}-private-{uid}）优先于路径尾段推导，
        // 否则 feishu-chat 工作区会因 projectKey 不匹配被误判为群聊分组。
        session.projectKey = cloudProjectKey != null && cloudProjectKey.trim().length > 0
          ? cloudProjectKey.trim()
          : SessionService.deriveProjectKey(workspace);
      } else {
        session.workspace = null;
        session.projectKey = null;
      }
    } else {
      session.workspace = workspace ?? null;
      session.projectKey = SessionService.deriveProjectKey(workspace ?? null);
    }

    await this.sessionRepo.insert(session);

    if (session.executionMode === 'CLOUD') {
      if (session.workspace == null || session.workspace.length === 0) {
        try {
          await this.initializeCloudWorkspace(session, userId, workspaceMode ?? null, cloudProjectKey ?? null, gitCloneUrl ?? null, gitBranch ?? null);
          const env = await this.environmentInfoProvider.detect(session.workspace);
          session.isGit = env.isGit;
          session.platform = env.platform;
          session.shellPath = env.shell;
          session.osVersion = env.osVersion;
          await this.sessionRepo.updateById(session);
        } catch (e) {
          await this.rollbackCreatedSession(session);
          throw e;
        }
      } else {
        const env = await this.environmentInfoProvider.detect(session.workspace);
        session.isGit = env.isGit;
        session.platform = env.platform;
        session.shellPath = env.shell;
        session.osVersion = env.osVersion;
        await this.sessionRepo.updateById(session);
      }
    }

    return session;
  }

  private async initializeCloudWorkspace(
    session: Session,
    userId: number,
    workspaceMode: string | null,
    cloudProjectKey: string | null,
    gitCloneUrl: string | null,
    gitBranch: string | null,
  ): Promise<void> {
    const mode = workspaceMode != null ? workspaceMode : 'new';

    if (mode === 'git' && gitCloneUrl != null && gitCloneUrl.trim().length > 0) {
      GitUrlParser.validate(gitCloneUrl);
      const slug = GitUrlParser.extractSlug(gitCloneUrl);
      const projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(this.pathSandbox, userId, slug);
      this.ensureWorkspaceDirectory(projectPath);
      const result = await this.gitOperationService.clone(gitCloneUrl, gitBranch, projectPath, userId, session.id ?? null);
      if (!result.success) {
        this.deleteWorkspaceDirectory(projectPath);
        throw new BusinessException(ErrorCode.GIT_CLONE_FAILED, result.error ?? ErrorCode.GIT_CLONE_FAILED.message);
      }
      session.workspace = projectPath;
      session.projectKey = slug;
      await this.sessionRepo.updateById(session);
    } else if (mode === 'existing' && cloudProjectKey != null && cloudProjectKey.trim().length > 0) {
      const slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
      const projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(this.pathSandbox, userId, slug);
      if (!existsSync(projectPath)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `工作区 "${slug}" 不存在`);
      }
      session.workspace = projectPath;
      session.projectKey = slug;
      await this.sessionRepo.updateById(session);
    } else if (cloudProjectKey != null && cloudProjectKey.trim().length > 0) {
      const slug = CloudWorkspaceResolver.normalizeAndValidate(cloudProjectKey);
      const projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(this.pathSandbox, userId, slug);
      this.ensureWorkspaceDirectory(projectPath);
      session.workspace = projectPath;
      session.projectKey = slug;
      await this.sessionRepo.updateById(session);
    } else {
      const autoPath = resolve(this.pathSandbox.getWorkspaceRoot(), String(userId), String(session.id));
      this.ensureWorkspaceDirectory(autoPath);
      session.workspace = autoPath;
      session.projectKey = SessionService.deriveProjectKey(autoPath);
      await this.sessionRepo.updateById(session);
    }
  }

  private async rollbackCreatedSession(session: Session): Promise<void> {
    if (session.id == null) {
      return;
    }
    const workspace = session.workspace;
    await this.sessionRepo.logicalDelete(session.id);
    if (workspace != null && workspace.trim().length > 0) {
      this.deleteWorkspaceDirectory(workspace);
    }
  }

  async listSessions(userId: number, keyword?: string | null, status?: string | null): Promise<Session[]> {
    const { whereSql, params } = this.baseSessionListQuery(userId, keyword, status);
    return this.sessionRepo.list(whereSql, params, 'ORDER BY is_pinned DESC, updated_at DESC, id DESC');
  }

  async listSessionGroups(userId: number, keyword: string | null | undefined, status: string | null | undefined, previewLimit: number): Promise<SessionGroupBucket[]> {
    const limit = Math.max(0, previewLimit);
    const all = await this.listSessions(userId, keyword, status);
    const byKey = new Map<string, Session[]>();
    const keyOrder: string[] = [];
    for (const s of all) {
      const key = SessionGroupKey.of(s);
      if (!byKey.has(key)) {
        byKey.set(key, []);
        keyOrder.push(key);
      }
      byKey.get(key)!.push(s);
    }
    const keys = [...keyOrder];
    keys.sort(SessionGroupKey.compareKeys);
    const groups: SessionGroupBucket[] = [];
    const agentMap = await this.batchLoadAgents(all);
    for (const key of keys) {
      const members = byKey.get(key)!;
      members.sort(SessionGroupKey.compareSessions);
      const total = members.length;
      const preview = limit >= total ? members : members.slice(0, limit);
      const first = members[0];
      const agentName = first.agentId != null ? agentMap.get(first.agentId)?.name : undefined;
      const groupName = first.title != null && first.title !== '飞书Bot会话' ? first.title : undefined;
      groups.push({ key, label: SessionGroupKey.formatLabel(key, agentName, groupName), total, hasMore: total > limit, sessions: [...preview] });
    }
    return groups;
  }

  async listSessionsByGroup(
    userId: number,
    groupKey: string,
    keyword: string | null | undefined,
    status: string | null | undefined,
    offset: number,
    limit: number,
  ): Promise<SessionGroupPage> {
    if (groupKey == null || groupKey.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, 'groupKey is required');
    }
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.min(Math.max(1, limit), 100);
    const base = this.baseSessionListQuery(userId, keyword, status);
    let filter;
    try {
      filter = SessionGroupKey.applyFilter(groupKey);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, (e as Error).message);
    }
    const whereSql = [...base.whereSql.split(' AND '), ...filter.clauses].join(' AND ');
    const params = [...base.params, ...filter.params];
    const total = await this.sessionRepo.count(whereSql, params);
    const orderSql = status === 'ARCHIVED'
      ? 'ORDER BY updated_at DESC, id DESC'
      : `ORDER BY CASE WHEN phase IN ('RUNNING','RESUMING','WAITING_APPROVAL') THEN 0 ELSE 1 END, is_pinned DESC, updated_at DESC, id DESC`;
    const items = await this.sessionRepo.list(
      whereSql,
      params,
      `${orderSql} LIMIT ${safeLimit} OFFSET ${safeOffset}`,
    );
    const hasMore = safeOffset + items.length < total;
    return { items, total, offset: safeOffset, limit: safeLimit, hasMore };
  }

  /**
   * Embed SDK 历史列表：当前用户、指定 agent、指定来源的主会话，updated_at 倒序分页。
   * limit 上限 50、默认 20（与 groupKey 分页的 100 上限独立，浮窗场景不需要更大页）。
   */
  async listSessionsByFilter(
    userId: number,
    agentId: number | null | undefined,
    source: SessionSource,
    offset: number,
    limit: number,
  ): Promise<SessionGroupPage> {
    // 非整数（1.5 / 1e21 等）截断，避免拼进 LIMIT/OFFSET 生成非法 SQL
    const safeOffset = Math.trunc(Math.max(0, offset));
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 50);
    const filter: SessionListFilter = {
      userId,
      agentId: parseEntityId(agentId) ?? null,
      source,
    };
    return this.sessionRepo.pageSessionsByFilter(filter, safeOffset, safeLimit);
  }

  /** 存量 SDK 常驻会话惰性标记：仅允许 web → embed 单向迁移，幂等 */
  async markSessionSource(sessionId: number, userId: number, source: SessionSource): Promise<Session> {
    const session = await this.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
    }
    if (source !== 'embed') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, "source 仅允许设置为 'embed'");
    }
    if (session.source === 'embed') {
      return session;
    }
    await this.sessionRepo.updateFields(sessionId, { source });
    return this.getSession(sessionId);
  }

  private baseSessionListQuery(
    userId: number,
    keyword?: string | null,
    status?: string | null,
  ): { whereSql: string; params: unknown[] } {
    const clauses = ['user_id = ?', `session_type NOT IN ('SUBAGENT', 'SIDE_TASK')`];
    const params: unknown[] = [userId];
    if (keyword != null && keyword.length > 0) {
      clauses.push('title LIKE ?');
      params.push(`%${keyword}%`);
    }
    if (status != null && status.length > 0) {
      clauses.push('status = ?');
      params.push(status);
    } else {
      clauses.push('status = ?');
      params.push('ACTIVE');
    }
    return { whereSql: clauses.join(' AND '), params };
  }

  listSideTaskSessions(parentSessionId: number, userId: number): Promise<Session[]> {
    return this.sessionRepo.list(
      `parent_session_id = ? AND user_id = ? AND session_type = 'SIDE_TASK' AND status <> 'ARCHIVED'`,
      [parentSessionId, userId],
      'ORDER BY created_at DESC',
    );
  }

  /** 递归列出根主会话树下的全部后代边路任务（updated_at 降序平铺），归档子树隐藏、孤儿不可达。 */
  async listDescendantSideTaskSessions(rootId: number, userId: number): Promise<Session[]> {
    return this.sessionRepo.listDescendantSideTasks(rootId, userId);
  }

  /** 批量递归：多个根主会话各自的全部后代边路任务（enrichSessions 首刷聚合用，按根分组）。 */
  listDescendantSideTaskSessionsByRoots(rootIds: number[]): Promise<Map<number, Session[]>> {
    return this.sessionRepo.listDescendantSideTasksByRoots(rootIds);
  }

  listSubagentSessions(parentSessionId: number, userId?: number): Promise<Session[]> {
    if (userId != null) {
      return this.sessionRepo.list(
        `parent_session_id = ? AND user_id = ? AND session_type = 'SUBAGENT' AND status <> 'ARCHIVED'`,
        [parentSessionId, userId],
        'ORDER BY created_at DESC',
      );
    }
    return this.sessionRepo.list(
      `parent_session_id = ? AND session_type = 'SUBAGENT' AND status <> 'ARCHIVED'`,
      [parentSessionId],
      '',
    );
  }

  async listSubagentSessionsWithSideTasks(parentSessionId: number, userId: number): Promise<Session[]> {
    const direct = await this.listSubagentSessions(parentSessionId, userId);
    const sideTasks = await this.listSideTaskSessions(parentSessionId, userId);
    if (sideTasks.length === 0) {
      return direct;
    }
    const sideTaskIds = sideTasks.map((s) => s.id!).filter((id) => id != null);
    if (sideTaskIds.length === 0) {
      return direct;
    }
    const placeholders = sideTaskIds.map(() => '?').join(',');
    const sideChildren = await this.sessionRepo.list(
      `parent_session_id IN (${placeholders}) AND user_id = ? AND session_type = 'SUBAGENT' AND status <> 'ARCHIVED'`,
      [...sideTaskIds, userId],
      '',
    );
    if (sideChildren.length === 0) {
      return direct;
    }
    const merged = [...direct, ...sideChildren];
    merged.sort((a, b) => {
      const au = a.createdAt ?? '';
      const bu = b.createdAt ?? '';
      return bu.localeCompare(au);
    });
    return merged;
  }

  async listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number | null,
    agentId?: number | null,
    executionMode?: string | null,
    phase?: string | null,
    keyword?: string | null,
    status?: string | null,
  ): Promise<{ records: Session[]; total: number; current: number; size: number; matchSnippets: Record<number, string> }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (userId != null) {
      clauses.push('user_id = ?');
      params.push(userId);
    }
    if (agentId != null) {
      clauses.push('agent_id = ?');
      params.push(agentId);
    }
    if (executionMode != null && executionMode.length > 0) {
      clauses.push('execution_mode = ?');
      params.push(executionMode);
    }
    if (phase != null && phase.length > 0) {
      if (phase.includes(',')) {
        const phases = phase.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        clauses.push(`phase IN (${phases.map(() => '?').join(',')})`);
        params.push(...phases);
      } else {
        clauses.push('phase = ?');
        params.push(phase);
      }
    }
    const trimmedKeyword = keyword != null ? keyword.trim() : '';
    if (trimmedKeyword.length > 0) {
      const escaped = escapeLike(trimmedKeyword);
      // 标题/摘要/消息正文任一命中即可；消息覆盖用户与助手，便于按聊天记录反查会话
      clauses.push(
        `(title LIKE ? ESCAPE '\\\\' OR summary LIKE ? ESCAPE '\\\\' OR id IN (
          SELECT m.session_id FROM message m
          WHERE m.deleted = 0 AND m.content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'
        ))`,
      );
      params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
    }
    clauses.push('status = ?');
    params.push(status != null && status.length > 0 ? status : 'ACTIVE');
    const whereSql = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    const result = await this.sessionRepo.selectPage(page, size, whereSql, params, 'ORDER BY created_at DESC');
    const matchSnippets = await this.loadAdminMatchSnippets(result.records, trimmedKeyword);
    return { ...result, current: page, size, matchSnippets };
  }

  private async loadAdminMatchSnippets(records: Session[], keyword: string): Promise<Record<number, string>> {
    if (keyword.length === 0 || records.length === 0) {
      return {};
    }
    const sessionIds = records.map((s) => s.id).filter((id): id is number => id != null);
    if (sessionIds.length === 0) {
      return {};
    }
    const hits = await this.messageRepo.selectFirstMatchingMessages(sessionIds, escapeLike(keyword));
    const matchSnippets: Record<number, string> = {};
    for (const hit of hits) {
      const text = this.extractVisibleText(hit.content ?? null);
      if (text == null || text.length === 0) continue;
      const snippet = buildSnippet(text, keyword);
      if (snippet != null) matchSnippets[hit.sessionId] = snippet;
    }
    return matchSnippets;
  }

  async getSession(id: number): Promise<Session> {
    const session = await this.sessionRepo.findById(id);
    if (session == null) {
      throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
    }
    return session;
  }

  async deleteSession(id: number): Promise<void> {
    const session = await this.sessionRepo.findById(id);
    if (session != null && (
      session.phase === 'RUNNING' || session.phase === 'WAITING_APPROVAL'
      || session.phase === 'RESUMING' || session.phase === 'CANCELLING'
    )) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '会话运行中，无法删除');
    }
    await this.sessionRepo.lockActiveSessionById(id);
    if (this.deleteSessionApprovalRules) {
      // 会话级审批规则物理删（V135）：WAITING_APPROVAL 拒删守卫保证无挂起审批，
      // 规则删除失败不阻断会话删除（残留行不参与匹配——会话已删、sessionId 不复用）
      try {
        await this.deleteSessionApprovalRules(id);
      } catch (e) {
        console.error(`Failed to delete approval rules for session ${id}`, e);
      }
    }
    await this.sessionCompactionService.deleteBySessionId(id);
    await this.sessionCompactionEventService.deleteBySessionId(id);
    await this.messageRepo.logicalDeleteBySession(id);
    await this.sessionRepo.logicalDelete(id);
    if (this.onSessionDeleted) {
      try {
        await this.onSessionDeleted(id);
      } catch (e) {
        console.error(`Failed to clean resources bound to session ${id}`, e);
      }
    }
    // 文件清理失败不影响会话删除本身（记录日志即可）
    if (session != null) {
      try {
        this.cleanupRuntimeDir?.(session.userId, id);
      } catch (e) {
        console.error(`Failed to clean runtime incoming dir for session ${id}`, e);
      }
      try {
        this.closeSessionTerminals?.(id);
      } catch (e) {
        console.error(`Failed to close cloud terminals for session ${id}`, e);
      }
      if (session.workspace != null && session.workspace.trim() !== '') {
        this.deleteRuntimeWorkspaceFiles(session.workspace);
      }
    }
  }

  /**
   * 删除会话工作区内残留的 runtime 临时文件（写入工作区时以 `mao-runtime-` 前缀存放）。
   * 仅删除该前缀命中的目录/文件，不影响用户项目文件。
   */
  private deleteRuntimeWorkspaceFiles(workspace: string): void {
    try {
      const root = this.pathSandbox.getEffectiveWorkspaceRoot(workspace);
      if (!existsSync(root) || !statSync(root).isDirectory()) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name.startsWith(RUNTIME_WORKSPACE_PREFIX)) {
          rmSync(resolve(root, entry.name), { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error(`Failed to clean runtime workspace files in ${workspace}`, e);
    }
  }

  async promoteSideTaskToMainSession(sideSessionId: number, userId: number): Promise<Session> {
    return this.sessionRepo.transaction(async (tx) => {
      const txSessionRepo = new SessionRepository(tx);
      const txMessageRepo = new MessageRepository(tx);
      const txFileChangeRepo = new FileChangeRepository(tx);
      const txTodoRepo = new SessionTodoRepository(tx);

      const source = await txSessionRepo.findByIdForUpdate(sideSessionId);
      if (source == null) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      if (source.userId !== userId) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
      }
      if (source.sessionType !== 'SIDE_TASK') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '只有边路任务可以升级为主会话');
      }
      if (source.phase === 'RUNNING' || source.phase === 'WAITING_APPROVAL' || source.phase === 'RESUMING' || source.phase === 'CANCELLING') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '边路任务运行中，无法升级为主会话');
      }
      // 仅拒绝存在子代理子会话的提升：SIDE_TASK 子树不受阻——子树的 parent_session_id
      // 本就指向被提升会话，提升后子树在树上自然跟随新主会话，无需重挂。
      const subagentChildren = await txSessionRepo.list(
        `parent_session_id = ? AND session_type = 'SUBAGENT' AND status <> 'ARCHIVED'`,
        [sideSessionId],
        'LIMIT 1',
      );
      if (subagentChildren.length > 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '边路任务存在子代理会话，无法升级为主会话');
      }

      const target: Session = {
        userId,
        agentId: source.agentId,
        title: source.title ?? '未命名会话',
        status: 'ACTIVE',
        isPinned: 0,
        isFavorite: 0,
        executionMode: source.executionMode,
        workspace: source.workspace,
        permissionLevel: source.permissionLevel,
        modelId: source.modelId,
        isGit: source.isGit,
        platform: source.platform,
        shellPath: source.shellPath,
        osVersion: source.osVersion,
        phase: 'IDLE',
        summary: source.summary,
        elapsedMs: 0,
        projectKey: source.projectKey ?? SessionService.deriveProjectKey(source.workspace),
        contextTokens: null,
        lastPromptTokens: null,
        unread: 0,
        parentSessionId: null,
        sessionType: 'NORMAL',
      };
      await txSessionRepo.insert(target);
      const targetId = target.id!;

      const messages = await txMessageRepo.listBySession(sideSessionId);
      const messageIdMap = new Map<number, number>();
      for (const m of messages) {
        const copy: Message = {
          sessionId: targetId,
          role: m.role,
          content: m.content,
          thinkingContent: m.thinkingContent,
          toolCallId: m.toolCallId,
          toolCalls: m.toolCalls,
          tokenCount: m.tokenCount,
          modelId: m.modelId,
          metadata: m.metadata,
          sourceSessionId: m.sourceSessionId ?? sideSessionId,
        };
        await txMessageRepo.insert(copy);
        if (m.id != null && copy.id != null) messageIdMap.set(m.id, copy.id);
      }

      const fileChanges = await txFileChangeRepo.listBySession(sideSessionId);
      for (const change of fileChanges) {
        if (change.messageId == null) continue;
        const mappedMessageId = messageIdMap.get(change.messageId);
        if (mappedMessageId == null) continue;
        await txFileChangeRepo.insert({
          messageId: mappedMessageId,
          sessionId: targetId,
          filePath: change.filePath,
          changeType: change.changeType,
          linesAdded: change.linesAdded,
          linesDeleted: change.linesDeleted,
          diffMode: change.diffMode,
          beforeContent: change.beforeContent,
          afterContent: change.afterContent,
          patchContent: change.patchContent,
          patchTruncated: change.patchTruncated,
          diffUnavailableReason: change.diffUnavailableReason,
        });
      }

      if (this.todoRepo != null) {
        const todos = await txTodoRepo.listBySession(sideSessionId);
        for (const todo of todos) {
          await txTodoRepo.insert({
            sessionId: targetId,
            content: todo.content,
            description: todo.description,
            activeForm: todo.activeForm,
            status: todo.status,
            sortOrder: todo.sortOrder,
            owner: todo.owner,
            claimedAt: todo.claimedAt,
            blockedBy: todo.blockedBy,
          } as SessionTodo);
        }
      }

      await tx.execute('DELETE FROM session_compaction WHERE session_id = ?', [sideSessionId]);
      await tx.execute('DELETE FROM session_compaction_event WHERE session_id = ?', [sideSessionId]);
      await txMessageRepo.logicalDeleteBySession(sideSessionId);
      // 提升是「插入新主会话 + 逻辑删除旧边路会话」：直接子会话的 parent 仍指向旧 id，
      // 不重挂则整棵边路子树在新旧两棵树上都不可达（BFS / 树信号 / 搜索全部失联）。
      // 子代理子会话已被前置校验拒绝，这里命中的只会是边路子树。
      await txSessionRepo.reparentChildrenTo(sideSessionId, targetId);
      await txSessionRepo.logicalDelete(sideSessionId);
      return target;
    });
  }

  async searchSessionsByUserMessage(userId: number, keyword: string | null | undefined): Promise<MessageSearchItem[]> {
    if (keyword == null || keyword.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少搜索关键词');
    }
    const trimmed = keyword.trim();
    if (trimmed.length > SEARCH_KEYWORD_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `搜索关键词不能超过 ${SEARCH_KEYWORD_MAX_LENGTH} 个字符`);
    }
    const escaped = escapeLike(trimmed);
    const candidates = await this.sessionRepo.selectMessageSearchCandidates(userId, escaped);
    if (candidates.length === 0) {
      return [];
    }
    const sessionIds = candidates.map((s) => s.id!);
    const hitMessages = await this.messageRepo.selectMessagesForSearch(sessionIds, escaped);
    const messagesBySession = new Map<number, Message[]>();
    for (const m of hitMessages) {
      if (m.content == null) continue;
      const list = messagesBySession.get(m.sessionId) ?? [];
      list.push(m);
      messagesBySession.set(m.sessionId, list);
    }
    const agentMap = await this.batchLoadAgents(candidates);
    // 边路会话结果需解析根主会话（前端以根会话为缓存键与跳转目标）；
    // 根不可达（父链上有已删除节点）的孤儿剔除——无法在树上打开。
    const rootIdBySession = await this.resolveSearchRoots(candidates);
    const items: MessageSearchItem[] = [];
    for (const s of candidates) {
      let snippet: string | null = null;
      for (const m of messagesBySession.get(s.id!) ?? []) {
        const text = this.extractVisibleText(m.content ?? null);
        if (text == null || text.length === 0) continue;
        snippet = buildSnippet(text, trimmed);
        if (snippet != null) break;
      }
      if (snippet == null) continue;
      if (s.sessionType === 'SIDE_TASK' && !rootIdBySession.has(s.id!)) continue;
      const agent = s.agentId != null ? agentMap.get(s.agentId) : undefined;
      items.push({
        id: s.id!,
        title: s.title,
        sessionType: s.sessionType,
        parentSessionId: s.parentSessionId,
        rootSessionId: s.sessionType === 'SIDE_TASK' ? rootIdBySession.get(s.id!) ?? null : s.id ?? null,
        updatedAt: javaLocalDateTimeString(s.updatedAt),
        phase: s.phase != null ? s.phase : 'IDLE',
        status: s.status ?? 'ACTIVE',
        agentName: agent?.name ?? null,
        snippet,
      });
    }
    return items;
  }

  /**
   * 批量解析搜索候选中边路会话所属的根主会话 id。
   * 候选至多 20 条：先把全部父会话一次性查出建映射，再逐链上溯；
   * 链上任何节点缺失（已删除）即视为孤儿，不为其产出根 id。
   */
  private async resolveSearchRoots(candidates: Session[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    const sideCandidates = candidates.filter((s) => s.sessionType === 'SIDE_TASK' && s.parentSessionId != null);
    if (sideCandidates.length === 0) return result;
    const needed = new Set<number>();
    for (const s of sideCandidates) needed.add(s.parentSessionId!);
    const parentById = new Map<number, Session>();
    for (let round = 0; round < 10 && needed.size > 0; round++) {
      const ids = [...needed];
      const placeholders = ids.map(() => '?').join(',');
      const rows = await this.sessionRepo.list(`id IN (${placeholders})`, ids, '');
      const nextNeeded = new Set<number>();
      for (const row of rows) {
        if (row.id == null) continue;
        parentById.set(row.id, row);
        if (row.parentSessionId != null && !parentById.has(row.parentSessionId)) {
          nextNeeded.add(row.parentSessionId);
        }
      }
      needed.clear();
      for (const id of nextNeeded) needed.add(id);
    }
    for (const s of sideCandidates) {
      let current = parentById.get(s.parentSessionId!);
      let guard = 0;
      while (current != null && current.parentSessionId != null && guard < 10) {
        current = parentById.get(current.parentSessionId);
        guard++;
      }
      if (current != null && current.parentSessionId == null && current.sessionType !== 'SIDE_TASK' && current.id != null) {
        result.set(s.id!, current.id);
      }
    }
    return result;
  }

  extractVisibleText(content: string | null): string | null {
    if (content == null) return null;
    const raw = content.trim();
    if (!raw.startsWith('[')) {
      return content;
    }
    try {
      const parts = JSON.parse(raw) as unknown[];
      if (parts.length === 0) {
        return content;
      }
      let sb = '';
      let multimodal = false;
      let allParts = true;
      for (const part of parts) {
        if (part && typeof part === 'object' && !Array.isArray(part)) {
          const map = part as Record<string, unknown>;
          const type = map.type;
          if (type === 'text') {
            if (map.text != null) sb += String(map.text);
            multimodal = true;
          } else if (type === 'image_url') {
            multimodal = true;
          } else {
            allParts = false;
          }
        } else {
          allParts = false;
        }
      }
      return multimodal && allParts ? sb : content;
    } catch (e) {
      console.warn(`Failed to parse multimodal message content, fallback to raw: ${(e as Error).message}`);
      return content;
    }
  }

  private async batchLoadAgents(sessions: Session[]): Promise<Map<number, AgentRef>> {
    const ids = collectEntityIds(sessions.map((s) => s.agentId));
    if (ids.length === 0) {
      return new Map();
    }
    const agents = await this.agentLookup.findByIds(ids);
    return new Map(agents.map((a) => [parseEntityId(a.id) ?? a.id, a]));
  }

  async togglePin(id: number): Promise<void> {
    const session = await this.getSession(id);
    const isPinned = session.isPinned != null && session.isPinned === 1 ? 0 : 1;
    await this.sessionRepo.updateFields(id, { isPinned });
  }

  async toggleFavorite(id: number): Promise<void> {
    const session = await this.getSession(id);
    const isFavorite = session.isFavorite != null && session.isFavorite === 1 ? 0 : 1;
    await this.sessionRepo.updateFields(id, { isFavorite });
  }

  async archiveSession(id: number): Promise<void> {
    await this.getSession(id);
    await this.sessionRepo.updateFields(id, { status: 'ARCHIVED' });
  }

  async unarchiveSession(id: number): Promise<void> {
    await this.getSession(id);
    await this.sessionRepo.updateFields(id, { status: 'ACTIVE' });
  }

  async restoreRunningAfterApproval(sessionId: number): Promise<boolean> {
    const rows = await this.sessionRepo.updateWhere(
      { phase: 'RUNNING', lastActivityAt: nowSql() },
      `id = ? AND phase = 'WAITING_APPROVAL' AND phase NOT IN ('FAILED', 'CANCELLED', 'COMPLETED')`,
      [sessionId],
    );
    return rows > 0;
  }

  async enterWaitingApproval(sessionId: number): Promise<boolean> {
    const rows = await this.sessionRepo.updateWhere(
      { phase: 'WAITING_APPROVAL', lastActivityAt: nowSql() },
      `id = ? AND phase NOT IN ('FAILED', 'CANCELLED', 'COMPLETED')`,
      [sessionId],
    );
    return rows > 0;
  }

  async save(session: Session): Promise<void> {
    await this.sessionRepo.insert(session);
  }

  async updateField(sessionId: number, field: string, value: unknown): Promise<void> {
    switch (field) {
      case 'status':
        await this.sessionRepo.updateFields(sessionId, { status: value });
        break;
      case 'phase': {
        const phase = String(value);
        const fields: Record<string, unknown> = { phase };
        if (phase === 'RUNNING' || phase === 'RESUMING') {
          fields.lastActivityAt = nowSql();
        }
        await this.sessionRepo.updateFields(sessionId, fields);
        break;
      }
      default:
        throw new Error(`Unsupported field: ${field}`);
    }
  }

  async saveMessage(
    sessionId: number,
    role: string,
    content: unknown,
    thinkingContent: string | null,
    toolCallId: string | null,
    toolCalls: string | null,
    tokenCount: number | null,
    modelId: number | null,
    metadata?: string | null,
  ): Promise<Message> {
    const message: Message = {
      sessionId,
      role,
      thinkingContent,
      toolCallId,
      toolCalls,
      tokenCount: tokenCount != null ? tokenCount : 0,
      modelId,
      metadata: metadata ?? null,
    };
    if (typeof content === 'string') {
      message.content = content;
    } else if (content != null) {
      try {
        message.content = toStoredContentJson(content);
      } catch {
        console.warn('Failed to serialize content to JSON, storing as string');
        message.content = String(content);
      }
    }
    await this.messageRepo.insert(message);

    const session = await this.sessionRepo.findById(sessionId);
    if (session != null) {
      await this.sessionRepo.updateFields(sessionId, { updatedAt: nowSql() });
    }
    return message;
  }

  async getMessages(sessionId: number): Promise<Message[]> {
    const messages = await this.messageRepo.listBySession(sessionId);
    return (MessageHistoryNormalizer.normalizeEntities(messages, parseToolCallsJson) ?? messages) as Message[];
  }

  getMessagesAfterId(sessionId: number, afterMessageId: number | null): Promise<Message[]> {
    const boundary = afterMessageId != null ? afterMessageId : 0;
    return this.messageRepo.selectMessagesAfterId(sessionId, boundary);
  }

  /** 取消息并校验归属：不存在、已删除或属于其他会话时返回 null。分叉切点校验用。 */
  findOwnedMessage(sessionId: number, messageId: number): Promise<Message | null> {
    return this.messageRepo.selectValidBoundaryMessage(sessionId, messageId);
  }

  /**
   * Fork 预览：边路任务创建前预演「发出首条消息后这条边路会话会看到的原始历史」。
   *
   * 走与 `/sessions/:id/messages` 完全相同的轮次分页口径（默认最近 N 轮、hasMore 翻页），
   * 只把上界从「最新一条」换成切点：切点是被点击那一轮的助手最终回复，轮次分页的起点查询
   * 必须含该轮的用户消息（`id <= 切点`），否则来源轮次整轮消失，预览与真实结果不符。
   * 无切点 = 全量分叉，与带 forkFromMessageId 的真实创建一一对应。
   */
  async getForkPreview(
    sessionId: number,
    cutMessageId: number | null,
    roundLimit: number,
    beforeMessageId: number | null = null,
  ): Promise<MessagePage> {
    const limit = Math.max(1, Math.min(roundLimit, 50));
    const userStarts = cutMessageId == null
      ? await this.messageRepo.selectUserStarts(sessionId, beforeMessageId, limit + 1)
      : await this.messageRepo.selectUserStartsThrough(sessionId, cutMessageId, beforeMessageId, limit + 1);
    if (userStarts.length === 0) {
      return { messages: [], hasMore: false, nextBeforeMessageId: null };
    }
    const hasMore = userStarts.length > limit;
    const pageStarts = hasMore ? userStarts.slice(0, limit) : userStarts;
    const startId = pageStarts[pageStarts.length - 1].id!;
    // 翻页时上界是「下一页起点之前」，与 /messages 的 beforeId 语义一致；带切点时仍不得越过切点
    const upperBound = Math.min(beforeMessageId ?? Number.MAX_SAFE_INTEGER, cutMessageId ?? Number.MAX_SAFE_INTEGER);
    const raw = upperBound >= Number.MAX_SAFE_INTEGER
      ? await this.messageRepo.selectRange(sessionId, startId, null)
      : await this.messageRepo.selectRangeThrough(sessionId, startId, upperBound);
    const messages = (MessageHistoryNormalizer.normalizeEntities(raw, parseToolCallsJson) ?? raw) as Message[];
    const nextBeforeMessageId = messages.length === 0 ? null : messages[0].id ?? null;
    return { messages, hasMore, nextBeforeMessageId };
  }

  async getMessagesByRounds(
    sessionId: number,
    roundLimit: number,
    beforeMessageId: number | null,
    options?: { maxMessageId?: number | null; excludeSourceSessionId?: number | null },
  ): Promise<MessagePage> {
    const limit = Math.max(1, Math.min(roundLimit, 50));
    const maxMessageId = options?.maxMessageId ?? null;
    const excludeSourceSessionId = options?.excludeSourceSessionId ?? null;
    let beforeMessage: Message | null = null;
    if (beforeMessageId != null) {
      beforeMessage = await this.messageRepo.findById(beforeMessageId);
      if (beforeMessage == null || beforeMessage.sessionId !== sessionId) {
        throw new BusinessException(ErrorCode.PARAM_INVALID);
      }
    }
    const beforeId = beforeMessage?.id ?? null;
    const userStarts = excludeSourceSessionId == null
      ? (maxMessageId == null
        ? await this.messageRepo.selectUserStarts(sessionId, beforeId, limit + 1)
        : await this.messageRepo.selectUserStarts(sessionId, beforeId, limit + 1, maxMessageId))
      : await this.messageRepo.selectUserStarts(sessionId, beforeId, limit + 1, maxMessageId, excludeSourceSessionId);
    if (userStarts.length === 0) {
      return { messages: [], hasMore: false, nextBeforeMessageId: null };
    }
    const hasMore = userStarts.length > limit;
    const pageStarts = hasMore ? userStarts.slice(0, limit) : userStarts;
    const startId = pageStarts[pageStarts.length - 1].id!;
    const raw = excludeSourceSessionId == null
      ? (maxMessageId == null
        ? await this.messageRepo.selectRange(sessionId, startId, beforeId)
        : await this.messageRepo.selectRange(sessionId, startId, beforeId, maxMessageId))
      : await this.messageRepo.selectRange(sessionId, startId, beforeId, maxMessageId, excludeSourceSessionId);
    const messages = (MessageHistoryNormalizer.normalizeEntities(raw, parseToolCallsJson) ?? raw) as Message[];
    const nextBeforeMessageId = messages.length === 0 ? null : messages[0].id ?? null;
    return { messages, hasMore, nextBeforeMessageId };
  }

  async getFileChangesBySession(sessionId: number): Promise<Map<number, FileChange[]>> {
    return groupFileChanges(await this.fileChangeRepo.listBySession(sessionId));
  }

  async getFileChangesByMessageIds(sessionId: number, messageIds: number[] | null): Promise<Map<number, FileChange[]>> {
    if (messageIds == null || messageIds.length === 0) {
      return new Map();
    }
    return groupFileChanges(await this.fileChangeRepo.listByMessageIds(sessionId, messageIds));
  }

  async listFileChangeSummaries(sessionId: number, excludeSourceSessionId?: number | null): Promise<FileChange[]> {
    return this.fileChangeRepo.listSummaryBySession(sessionId, excludeSourceSessionId);
  }

  async getFileChangeSummariesByMessageIds(sessionId: number, messageIds: number[] | null): Promise<Map<number, FileChange[]>> {
    if (messageIds == null || messageIds.length === 0) {
      return new Map();
    }
    return groupFileChanges(await this.fileChangeRepo.listSummaryByMessageIds(sessionId, messageIds));
  }

  async cleanupIncompleteTail(sessionId: number): Promise<number> {
    return this.cleanupIncompleteTailList(sessionId, await this.getMessages(sessionId));
  }

  async cleanupIncompleteTailAfterId(sessionId: number, afterMessageId: number): Promise<number> {
    const messages = (MessageHistoryNormalizer.normalizeEntities(await this.getMessagesAfterId(sessionId, afterMessageId), parseToolCallsJson) ?? []) as Message[];
    return this.cleanupIncompleteTailList(sessionId, messages);
  }

  private async cleanupIncompleteTailList(sessionId: number, messages: Message[]): Promise<number> {
    if (messages.length === 0) return 0;
    let filled = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'ASSISTANT' || msg.toolCalls == null || msg.toolCalls.length === 0) continue;
      const expectedIds = extractToolCallIds(msg.toolCalls);
      if (expectedIds.size === 0) continue;
      const foundIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const subsequent = messages[j];
        if (subsequent.role === 'TOOL' && subsequent.toolCallId != null) {
          foundIds.add(subsequent.toolCallId);
        } else if (subsequent.role === 'ASSISTANT') {
          break;
        }
      }
      for (const id of expectedIds) {
        if (foundIds.has(id)) continue;
        await this.saveMessage(sessionId, 'TOOL', MISSING_TOOL_RESULT_PLACEHOLDER, null, id, null, 0, null);
        filled++;
      }
    }
    if (filled > 0) {
      console.info(`Session ${sessionId}: filled ${filled} missing tool output(s)`);
    }
    return filled;
  }

  /** 按会话范围回滚单条消息：入站消息被更新消息取代时清理，避免历史中留下无回复的孤立 USER。 */
  async deleteMessageById(sessionId: number, messageId: number): Promise<void> {
    await this.messageRepo.logicalDeleteByIdInSession(sessionId, messageId);
  }

  async editMessageAndTruncate(sessionId: number, messageId: number, newContent: string | null, images: string[] | null): Promise<Message> {
    const message = await this.messageRepo.findById(messageId);
    if (message == null || message.role !== 'USER') {
      throw new Error('只能编辑用户消息');
    }
    if (message.sessionId !== sessionId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该消息');
    }
    const lastUser = await this.getLastUserMessage(sessionId);
    if (!lastUser || lastUser.id !== messageId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '只能编辑最后一条用户消息');
    }
    await this.sessionRepo.lockActiveSessionById(sessionId);
    const compaction = await this.sessionCompactionService.loadValidated(message.sessionId);
    if (compaction != null && messageId <= this.sessionCompactionService.boundaryOf(compaction)) {
      throw new BusinessException(ErrorCode.MESSAGE_ALREADY_COMPACTED);
    }
    message.content = buildEditContent(newContent, images);
    message.updatedAt = nowSql();
    await this.messageRepo.updateById(message);
    await this.messageRepo.logicalDeleteAfter(message.sessionId, messageId);
    console.info(`Edited message ${messageId} in session ${message.sessionId}, truncated subsequent messages`);
    return message;
  }

  /**
   * 停机/排空收尾：仅当会话仍在运行态才标记为被中断（原子 CAS）。
   *
   * 不能"先 getSession 读 phase 再 updatePhase"——执行线程可能在两者之间写入 COMPLETED，
   * 无条件写会把终态覆盖回 RESUMING，而已完成的会话随后会被孤儿巡检重新执行一遍。
   * 返回是否真的标记成功。
   */
  async markInterruptedIfActive(sessionId: number): Promise<boolean> {
    const affected = await this.sessionRepo.markPhaseIfIn(sessionId, 'RESUMING', ['RUNNING', 'RESUMING']);
    return affected > 0;
  }

  async updatePhase(sessionId: number, phase: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const oldPhase = session.phase;
    const fields: Record<string, unknown> = { phase, lastActivityAt: nowSql() };
    if (phase === 'RUNNING') {
      if (session.startedAt == null) {
        fields.startedAt = nowSql();
      }
    } else if (phase === 'IDLE' || phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED') {
      if (session.startedAt != null) {
        const elapsed = Date.parse(session.startedAt.replace(' ', 'T')) ? Date.now() - Date.parse(toIso(session.startedAt)) : 0;
        fields.elapsedMs = (session.elapsedMs != null ? session.elapsedMs : 0) + Math.max(0, elapsed);
        fields.startedAt = null;
      }
      // 微信/飞书通道会话由机器人等外部触发，终态不计未读，避免聚焦模式被无人工关注的会话置顶
      if (!isTerminalPhase(oldPhase) && isTerminalPhase(phase)
        && session.projectKey !== WEIXIN_PROJECT_KEY
        && !isFeishuChannelSession(session.projectKey, session.workspace)) {
        fields.unread = 1;
      }
    }
    await this.sessionRepo.updateFields(sessionId, fields);
  }

  async markLastMessageFinished(sessionId: number): Promise<void> {
    const last = await this.messageRepo.selectLast(sessionId);
    if (last != null) {
      last.updatedAt = nowSql();
      await this.messageRepo.updateById(last);
    }
  }

  async markAsRead(sessionId: number): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session.unread === 1) {
      await this.sessionRepo.updateFields(sessionId, { unread: 0 });
    }
  }

  async updateSummary(sessionId: number, summary: string): Promise<void> {
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { summary });
  }

  async updateProjectKey(sessionId: number, projectKey: string): Promise<void> {
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { projectKey });
  }

  async updateTitle(sessionId: number, title: string): Promise<void> {
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { title });
  }

  async updatePermissionLevel(sessionId: number, permissionLevel: string): Promise<void> {
    permissionFromString(permissionLevel);
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { permissionLevel });
  }

  async updateMemoryInjectionDisabled(sessionId: number, disabled: boolean): Promise<void> {
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { memoryInjectionDisabled: disabled ? 1 : 0 });
  }

  async updateModelId(sessionId: number, modelId: number): Promise<void> {
    await this.getSession(sessionId);
    await this.sessionRepo.updateFields(sessionId, { modelId });
  }

  async updateContextTokens(sessionId: number, contextTokens: number): Promise<void> {
    await this.sessionRepo.updateFields(sessionId, { contextTokens });
  }

  async updateRuntimeStatus(sessionId: number, runtimeStatus: unknown | null): Promise<void> {
    await this.sessionRepo.updateFields(sessionId, {
      runtimeStatusJson: runtimeStatus == null ? null : JSON.stringify(runtimeStatus),
    });
  }

  async updateContextAnchor(sessionId: number, lastPromptTokens: number, contextAnchorMsgId: number): Promise<void> {
    await this.sessionRepo.updateFields(sessionId, {
      lastPromptTokens,
      contextAnchorMsgId,
      contextTokens: lastPromptTokens,
    });
  }

  async clearContextAnchor(sessionId: number): Promise<void> {
    await this.sessionRepo.updateFields(sessionId, { lastPromptTokens: 0, contextAnchorMsgId: 0 });
  }

  getMaxMessageId(sessionId: number): Promise<number> {
    return this.messageRepo.selectMaxMessageId(sessionId);
  }

  /** 按 id 单调序取最后一条用户消息，不受 created_at 时钟偏移影响。 */
  getLastUserMessage(sessionId: number): Promise<Message | null> {
    return this.messageRepo.selectLastUserMessage(sessionId);
  }

  async loadContextAnchor(sessionId: number): Promise<ContextAnchor> {
    const session = await this.getSession(sessionId);
    return {
      lastPromptTokens: session.lastPromptTokens ?? 0,
      contextAnchorMsgId: session.contextAnchorMsgId ?? 0,
    };
  }

  async listSessionsForDashboard(userId: number): Promise<Record<string, Session[]>> {
    const running = await this.sessionRepo.list(
      `user_id = ? AND status = 'ACTIVE' AND phase IN ('RUNNING', 'RESUMING', 'WAITING_APPROVAL')`,
      [userId],
      'ORDER BY last_activity_at DESC',
    );
    const recent = await this.sessionRepo.list(
      `user_id = ? AND status = 'ACTIVE' AND phase NOT IN ('RUNNING', 'RESUMING', 'WAITING_APPROVAL')`,
      [userId],
      'ORDER BY updated_at DESC LIMIT 20',
    );
    return { running, recent };
  }

  async touchLastActivity(sessionId: number): Promise<void> {
    const session = await this.sessionRepo.findById(sessionId);
    if (session == null) return;
    const phase = session.phase;
    if (phase !== 'RUNNING' && phase !== 'RESUMING') return;
    await this.sessionRepo.updateFields(sessionId, { lastActivityAt: nowSql() });
  }

  private ensureWorkspaceDirectory(path: string): void {
    try {
      mkdirSync(path, { recursive: true });
    } catch (e) {
      console.error(`Failed to create workspace directory: ${path}`, e);
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '工作区目录创建失败');
    }
  }

  private deleteWorkspaceDirectory(path: string): void {
    try {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to delete workspace directory: ${path}`, e);
    }
  }

  static deriveProjectKey(workspace: string | null | undefined): string | null {
    if (workspace == null || workspace.trim().length === 0) return null;
    const normalized = workspace.replace(/\\/g, '/');
    const parts = normalized.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) return parts[i];
    }
    return null;
  }
}

export function buildSnippet(text: string | null, keyword: string | null): string | null {
  if (text == null || keyword == null || keyword.length === 0) return null;
  const idx = indexOfIgnoreCase(text, keyword);
  if (idx < 0) return null;
  const kwLen = keyword.length;
  let ctx = SNIPPET_CONTEXT_CHARS;
  if (kwLen + ctx * 2 > SNIPPET_MAX_LENGTH) {
    ctx = Math.max(0, Math.floor((SNIPPET_MAX_LENGTH - kwLen) / 2));
  }
  const start = Math.max(0, idx - ctx);
  const end = Math.min(text.length, idx + kwLen + ctx);
  const body = text.slice(start, end);
  return (start > 0 ? '…' : '') + body + (end < text.length ? '…' : '');
}

export function indexOfIgnoreCase(text: string, keyword: string): number {
  return text.toLowerCase().indexOf(keyword.toLowerCase());
}

function escapeLike(keyword: string): string {
  return keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function groupFileChanges(changes: FileChange[]): Map<number, FileChange[]> {
  const grouped = new Map<number, FileChange[]>();
  for (const fc of changes) {
    const list = grouped.get(fc.messageId) ?? [];
    list.push(fc);
    grouped.set(fc.messageId, list);
  }
  return grouped;
}

function extractToolCallIds(toolCallsJson: string): Set<string> {
  const ids = new Set<string>();
  try {
    const array = JSON.parse(toolCallsJson) as unknown;
    if (Array.isArray(array)) {
      for (const tc of array) {
        if (tc && typeof tc === 'object' && 'id' in tc && (tc as { id?: unknown }).id != null) {
          ids.add(String((tc as { id: unknown }).id));
        }
      }
    }
  } catch (e) {
    console.warn(`Failed to parse tool_calls JSON for tail cleanup: ${(e as Error).message}`);
  }
  return ids;
}

function buildEditContent(text: string | null, images: string[] | null): string | null {
  if (images == null || images.length === 0) {
    return text;
  }
  const parts: unknown[] = [{ type: 'text', text: text ?? '' }];
  for (const imageUrl of images) {
    parts.push({ type: 'image_url', image_url: { url: imageUrl } });
  }
  try {
    return JSON.stringify(parts);
  } catch {
    return text;
  }
}

function isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === 'IDLE' || phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}

function toIso(sql: string): string {
  return sql.includes('T') ? sql : sql.replace(' ', 'T');
}

function parseToolCallsJson(json: string): Array<{ id?: string }> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed as Array<{ id?: string }> : [];
  } catch {
    return [];
  }
}
