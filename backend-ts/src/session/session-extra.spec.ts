import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SessionService } from './session.service.js';
import { SessionGroupKey } from './util/session-group-key.js';
import { SessionActivityHeartbeat } from './session-activity-heartbeat.js';
import { TaskTerminalService } from './task-terminal.service.js';
import { GitOperationService } from './git-operation.service.js';
import { GitUrlParser } from './util/git-url-parser.js';

function makeService() {
  const sessionRepo = {
    insert: vi.fn(async (s: { id?: number }) => { s.id = 11; return 11; }),
    updateById: vi.fn(),
    findById: vi.fn(),
    updateFields: vi.fn(),
    updateWhere: vi.fn(async () => 1),
    list: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    selectPage: vi.fn(async () => ({ records: [], total: 0 })),
    logicalDelete: vi.fn(),
    listSideTasks: vi.fn(async () => []),
    lockActiveSessionById: vi.fn(async () => 11),
    selectMessageSearchCandidates: vi.fn(async () => []),
    markPhaseIfIn: vi.fn(async () => 1),
  };
  const messageRepo = {
    insert: vi.fn(async (m: { id?: number }) => { m.id = 21; return 21; }),
    updateById: vi.fn(),
    listBySession: vi.fn(async () => []),
    selectMessagesAfterId: vi.fn(async () => []),
    selectMaxMessageId: vi.fn(async () => 0),
    selectLast: vi.fn(async () => null),
    logicalDeleteAfter: vi.fn(),
    deleteFromId: vi.fn(),
    findById: vi.fn(),
    logicalDeleteBySession: vi.fn(),
    logicalDeleteById: vi.fn(),
    selectUserStarts: vi.fn(async () => []),
    selectRange: vi.fn(async () => []),
    selectThroughMessage: vi.fn(async () => []),
    selectUserStartsThrough: vi.fn(async () => []),
    selectRangeThrough: vi.fn(async () => []),
    selectToolMessagesByCallIds: vi.fn(async () => []),
    selectMessagesForSearch: vi.fn(async () => []),
    selectFirstMatchingMessages: vi.fn(async () => []),
    selectLastUserMessage: vi.fn(async () => null),
  };
  const fileChangeRepo = {
    listBySession: vi.fn(async () => []),
    listByMessageIds: vi.fn(async () => []),
  };
  const agentLookup = {
    requireDefaultAgent: vi.fn(async () => ({ id: 9, name: 'A' })),
    findById: vi.fn(async () => ({ id: 9, name: 'A' })),
    findByIds: vi.fn(async () => []),
  };
  const pathSandbox = { getWorkspaceRoot: () => useTmpDir('ws-') };
  const env = { detect: vi.fn(async () => ({ isGit: false, platform: 'darwin', shell: 'bash', osVersion: 'Darwin' })) };
  const git = { clone: vi.fn() };
  const service = new SessionService(
    sessionRepo as never,
    messageRepo as never,
    fileChangeRepo as never,
    agentLookup as never,
    pathSandbox as never,
    env as never,
    { listAvailableForUser: vi.fn() } as never,
    git as never,
    { deleteBySessionId: vi.fn(), loadValidated: vi.fn(async () => null), boundaryOf: vi.fn(() => 0) } as never,
    { deleteBySessionId: vi.fn() } as never,
  );
  return { service, sessionRepo, messageRepo, fileChangeRepo, agentLookup, env };
}

describe('SessionService extra', () => {
  it('createSessionUsesDefaultAgentAndCloudWorkspace', async () => {
    const { service, sessionRepo, agentLookup, env } = makeService();
    const created = await service.createSession(7, null, null);
    expect(agentLookup.requireDefaultAgent).toHaveBeenCalled();
    expect(created.id).toBe(11);
    expect(created.title).toBe('未命名会话');
    expect(created.executionMode).toBe('CLOUD');
    expect(sessionRepo.insert).toHaveBeenCalled();
    expect(env.detect).toHaveBeenCalled();
  });

  it('createSessionLocalKeepsWorkspaceAndToggles', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({
      id: 11, userId: 7, isPinned: 0, isFavorite: 0, status: 'ACTIVE', phase: 'IDLE', lastPromptTokens: 3, contextAnchorMsgId: 8,
    });
    const local = await service.createSession(7, 9, 't', 'LOCAL', '/Users/me/proj');
    expect(local.workspace).toBe('/Users/me/proj');
    expect(SessionService.deriveProjectKey('/Users/me/proj')).toBe('proj');
    expect(SessionService.deriveProjectKey(null)).toBeNull();

    await service.togglePin(11);
    await service.toggleFavorite(11);
    await service.archiveSession(11);
    await service.updateTitle(11, 'n');
    await service.updateSummary(11, 's');
    await service.updateProjectKey(11, 'k');
    await service.updatePermissionLevel(11, 'READ_WRITE');
    await service.updateModelId(11, 3);
    await service.updateContextTokens(11, 100);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, { contextTokens: 100 });
    await service.updateContextTokens(11, 80, '{"sections":[]}');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, { contextTokens: 80, contextManifestJson: '{"sections":[]}' });
    await service.updateContextTokens(11, 70, null);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, { contextTokens: 70, contextManifestJson: null });

    vi.mocked(sessionRepo.updateFields).mockClear();
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writes = 0;
    vi.mocked(sessionRepo.updateFields).mockImplementation(async () => {
      writes += 1;
      if (writes === 1) await firstGate;
    });
    const older = service.updateContextTokens(11, 42, '{"sections":[{"key":"old"}]}');
    const newer = service.updateContextTokens(11, 4, '{"sections":[{"key":"new"}]}');
    for (let i = 0; i < 5 && vi.mocked(sessionRepo.updateFields).mock.calls.length < 1; i++) {
      await Promise.resolve();
    }
    expect(sessionRepo.updateFields).toHaveBeenCalledTimes(1);
    releaseFirst();
    await older;
    await newer;
    expect(sessionRepo.updateFields).toHaveBeenNthCalledWith(1, 11, {
      contextTokens: 42, contextManifestJson: '{"sections":[{"key":"old"}]}',
    });
    expect(sessionRepo.updateFields).toHaveBeenNthCalledWith(2, 11, {
      contextTokens: 4, contextManifestJson: '{"sections":[{"key":"new"}]}',
    });
    await service.updateContextAnchor(11, 1, 2);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, expect.objectContaining({ lastPromptTokens: 1, contextAnchorMsgId: 2 }));
    const anchor = await service.loadContextAnchor(11);
    expect(anchor.contextAnchorMsgId).toBe(8);
    await service.clearContextAnchor(11);
    await service.updatePhase(11, 'RUNNING');
    await service.markAsRead(11);
    await service.touchLastActivity(11);
    vi.mocked(sessionRepo.updateById).mockClear();
    vi.mocked(sessionRepo.updateFields).mockClear();
    await service.saveMessage(11, 'USER', 'hi');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, expect.objectContaining({ updatedAt: expect.any(String) }));
    expect(sessionRepo.updateById).not.toHaveBeenCalled();
    expect(await service.enterWaitingApproval(11)).toBe(true);
    await service.listSessions(7);
    await service.listSessionsForDashboard(7);
    await service.deleteSession(11);
    expect(sessionRepo.logicalDelete).toHaveBeenCalled();
  });

  it('updateMemoryInjectionDisabledWritesNumericFlag', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue({ id: 11, userId: 7 } as never);
    await service.updateMemoryInjectionDisabled(11, true);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, { memoryInjectionDisabled: 1 });
    await service.updateMemoryInjectionDisabled(11, false);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, { memoryInjectionDisabled: 0 });
  });

  it('createSessionCloudPrefersExplicitCloudProjectKeyForFeishuPrivate', async () => {
    const { service } = makeService();
    const feishuPrivate = await service.createSession(
      7, 9, '飞书Bot会话', 'CLOUD', '/opt/mao-data/workspace/feishu-chat/1/private-3', 'FULL',
      false, 'linux', '/bin/bash', 'Linux', null, 'feishu-1-private-3',
    );
    expect(feishuPrivate.projectKey).toBe('feishu-1-private-3');
    // 分组判定：私聊 projectKey 命中后归入 FEISHU_PRIVATE，而非按 workspace 误判为飞书群聊。
    expect(SessionGroupKey.of(feishuPrivate)).toBe('FEISHU_PRIVATE:9');

    const withoutKey = await service.createSession(
      7, 9, 't', 'CLOUD', '/opt/mao-data/workspace/feishu-chat/1/oc_abc', 'FULL',
      false, 'linux', '/bin/bash', 'Linux', null,
    );
    expect(withoutKey.projectKey).toBe('oc_abc');
  });

  it('updatePhase terminal sets unread except for weixin channel sessions', async () => {
    const { service, sessionRepo } = makeService();
    sessionRepo.findById.mockResolvedValue({ id: 11, userId: 7, phase: 'RUNNING', startedAt: null });
    await service.updatePhase(11, 'COMPLETED');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(11, expect.objectContaining({ unread: 1 }));

    sessionRepo.findById.mockResolvedValue({ id: 12, userId: 7, phase: 'RUNNING', startedAt: null, projectKey: 'weixin-bot' });
    await service.updatePhase(12, 'COMPLETED');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(12, expect.not.objectContaining({ unread: expect.anything() }));

    sessionRepo.findById.mockResolvedValue({ id: 13, userId: 7, phase: 'RUNNING', startedAt: null, projectKey: 'feishu-1-private-2' });
    await service.updatePhase(13, 'COMPLETED');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(13, expect.not.objectContaining({ unread: expect.anything() }));

    sessionRepo.findById.mockResolvedValue({ id: 14, userId: 7, phase: 'RUNNING', startedAt: null, projectKey: 'oc_group', workspace: '/opt/mao-data/workspace/feishu-chat/1/oc_group' });
    await service.updatePhase(14, 'COMPLETED');
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(14, expect.not.objectContaining({ unread: expect.anything() }));
  });

  it('createSessionThrowsWhenAgentMissing', async () => {
    const { service, agentLookup } = makeService();
    agentLookup.findById.mockResolvedValue(null);
    await expect(service.createSession(7, 99, 'x')).rejects.toBeInstanceOf(BusinessException);
  });

  it('createSessionRejectsDisabledAgent', async () => {
    const { service, agentLookup, sessionRepo } = makeService();
    agentLookup.findById.mockResolvedValue({ id: 9, name: 'A', enabled: 0 });
    await expect(service.createSession(7, 9, 'x')).rejects.toBeInstanceOf(BusinessException);
    expect(sessionRepo.insert).not.toHaveBeenCalled();
  });

  it('lists groups search messages rounds and cleanup', async () => {
    const { service, sessionRepo, messageRepo, fileChangeRepo, agentLookup } = makeService();
    sessionRepo.list.mockResolvedValue([
      { id: 1, userId: 7, title: 'a', executionMode: 'CLOUD', workspace: null, sessionType: 'NORMAL', isPinned: 0, updatedAt: '2026-01-01 00:00:00' },
      { id: 2, userId: 7, title: 'b', executionMode: 'LOCAL', workspace: '/tmp/p', sessionType: 'NORMAL', isPinned: 1, updatedAt: '2026-01-02 00:00:00' },
    ]);
    const groups = await service.listSessionGroups(7, 'a', 'ACTIVE', 1);
    expect(groups.length).toBeGreaterThan(0);
    sessionRepo.count.mockResolvedValue(2);
    sessionRepo.list.mockResolvedValue([{ id: 1 }]);
    const page = await service.listSessionsByGroup(7, 'CLOUD:临时工作区', null, null, 0, 10);
    expect(page.total).toBe(2);
    await expect(service.listSessionsByGroup(7, '', null, null, 0, 10)).rejects.toBeInstanceOf(BusinessException);

    await service.listSideTaskSessions(1, 7);
    await service.listSubagentSessions(1, 7);
    await service.listSubagentSessions(1);
    sessionRepo.list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 20 }]).mockResolvedValueOnce([]);
    await service.listSubagentSessionsWithSideTasks(1, 7);
    sessionRepo.selectPage.mockResolvedValue({ records: [], total: 0 });
    await service.listSessionsForAdmin(1, 10, 7, 9, 'CLOUD', 'RUNNING,IDLE', 'kw', 'ACTIVE');
    await service.listSessionsForAdmin(1, 10, null, null, null, 'IDLE', null, null);

    sessionRepo.selectMessageSearchCandidates.mockResolvedValue([{ id: 11, title: 't', sessionType: 'NORMAL', agentId: 9, updatedAt: '2026-01-01 00:00:00' }]);
    messageRepo.selectMessagesForSearch.mockResolvedValue([{ id: 1, sessionId: 11, content: 'hello world keyword' }]);
    agentLookup.findByIds.mockResolvedValue([{ id: 9, name: 'A' }]);
    const hits = await service.searchSessionsByUserMessage(7, 'keyword');
    expect(hits[0].snippet).toBeTruthy();
    await expect(service.searchSessionsByUserMessage(7, '')).rejects.toBeInstanceOf(BusinessException);
    expect(service.extractVisibleText(null)).toBeNull();
    expect(service.extractVisibleText('plain')).toBe('plain');
    expect(service.extractVisibleText(JSON.stringify([{ type: 'text', text: 'hi' }, { type: 'image_url' }]))).toBe('hi');

    messageRepo.listBySession.mockResolvedValue([{ id: 1, role: 'USER', content: 'hi' }]);
    await service.getMessages(11);
    await service.getMessagesAfterId(11, 1);
    messageRepo.findById.mockResolvedValue({ id: 5, sessionId: 11, role: 'USER' });
    messageRepo.selectUserStarts.mockResolvedValue([{ id: 5, role: 'USER' }]);
    messageRepo.selectRange.mockResolvedValue([{ id: 5, role: 'USER', content: 'x' }]);
    const rounds = await service.getMessagesByRounds(11, 2, 5);
    expect(rounds.messages.length).toBe(1);
    messageRepo.selectUserStarts.mockResolvedValue([{ id: 3, role: 'USER' }]);
    messageRepo.selectRange.mockResolvedValue([{ id: 3, role: 'USER', content: 'q' }]);
    await service.getMessagesByRounds(11, 2, null, { maxMessageId: 4 });
    expect(messageRepo.selectUserStarts).toHaveBeenLastCalledWith(11, null, 3, 4);
    expect(messageRepo.selectRange).toHaveBeenLastCalledWith(11, 3, null, 4);
    await service.getMessagesByRounds(11, 2, null, { excludeSourceSessionId: 99 });
    expect(messageRepo.selectUserStarts).toHaveBeenLastCalledWith(11, null, 3, null, 99);
    expect(messageRepo.selectRange).toHaveBeenLastCalledWith(11, 3, null, null, 99);
    fileChangeRepo.listBySession.mockResolvedValue([{ messageId: 1, path: 'a.ts' }]);
    await service.getFileChangesBySession(11);
    await service.getFileChangesByMessageIds(11, [1]);
    await service.getFileChangesByMessageIds(11, []);

    // fork 预览：切点为空时与 /messages 同路（起点查询不复用含边界版本）
    messageRepo.selectUserStarts.mockResolvedValue([
      { id: 3, role: 'USER' }, { id: 2, role: 'USER' }, { id: 1, role: 'USER' },
    ]);
    messageRepo.selectRange.mockResolvedValue([{ id: 2, role: 'USER', content: 'q1' }]);
    const full = await service.getForkPreview(11, null, 2);
    expect(messageRepo.selectUserStarts).toHaveBeenLastCalledWith(11, null, 3);
    expect(messageRepo.selectRange).toHaveBeenLastCalledWith(11, 2, null);
    expect(full.hasMore).toBe(true);
    expect(full.nextBeforeMessageId).toBe(2);
    expect(messageRepo.selectUserStartsThrough).not.toHaveBeenCalled();
    expect(messageRepo.selectRangeThrough).not.toHaveBeenCalled();

    // 带切点：起点查询改用含边界版本，否则来源那一轮整轮丢失
    messageRepo.selectUserStartsThrough.mockResolvedValue([{ id: 3, role: 'USER' }]);
    messageRepo.selectRangeThrough.mockResolvedValue([
      { id: 1, role: 'USER', content: 'q1' },
      { id: 2, role: 'ASSISTANT', content: 'a1' },
      { id: 3, role: 'USER', content: 'q2' },
      { id: 4, role: 'ASSISTANT', content: 'a2' },
    ]);
    const cut = await service.getForkPreview(11, 4, 5);
    expect(messageRepo.selectUserStartsThrough).toHaveBeenCalledWith(11, 4, null, 6);
    expect(messageRepo.selectRangeThrough).toHaveBeenCalledWith(11, 3, 4);
    expect(cut.messages).toHaveLength(4);
    expect(cut.hasMore).toBe(false);

    // 向上翻页：上界取「翻页游标」与「切点」的较小值，不能越过切点把更晚的内容带进来
    messageRepo.selectUserStartsThrough.mockResolvedValue([{ id: 9, role: 'USER' }]);
    messageRepo.selectRangeThrough.mockResolvedValue([{ id: 8, role: 'USER', content: 'q0' }]);
    const older = await service.getForkPreview(11, 4, 5, 99);
    expect(messageRepo.selectUserStartsThrough).toHaveBeenCalledWith(11, 4, 99, 6);
    expect(messageRepo.selectRangeThrough).toHaveBeenCalledWith(11, 9, 4);
    expect(older.nextBeforeMessageId).toBe(8);

    // 翻页游标小于切点（或无切点）时上界排他，不把上一页首条再带回
    messageRepo.selectRangeThrough.mockClear();
    messageRepo.selectUserStarts.mockResolvedValue([{ id: 1, role: 'USER' }]);
    messageRepo.selectRange.mockResolvedValue([
      { id: 1, role: 'USER', content: 'q0' },
      { id: 2, role: 'ASSISTANT', content: 'a0' },
    ]);
    const paged = await service.getForkPreview(11, null, 5, 3);
    expect(messageRepo.selectRange).toHaveBeenLastCalledWith(11, 1, 3);
    expect(messageRepo.selectRangeThrough).not.toHaveBeenCalled();
    expect(paged.messages.map((message) => message.id)).toEqual([1, 2]);

    messageRepo.selectUserStartsThrough.mockResolvedValue([{ id: 1, role: 'USER' }]);
    await service.getForkPreview(11, 10, 5, 3);
    expect(messageRepo.selectUserStartsThrough).toHaveBeenLastCalledWith(11, 10, 3, 6);
    expect(messageRepo.selectRange).toHaveBeenLastCalledWith(11, 1, 3);

    messageRepo.listBySession.mockResolvedValue([
      { id: 1, role: 'USER', content: 'q' },
      { id: 2, role: 'ASSISTANT', content: 'a', toolCalls: JSON.stringify([{ id: 'tc1' }, { id: 'tc2' }]) },
      { id: 3, role: 'TOOL', content: 'ok', toolCallId: 'tc1' },
      { id: 4, role: 'USER', content: 'continue' },
    ]);
    expect(await service.cleanupIncompleteTail(11)).toBeGreaterThan(0);
    expect(messageRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      role: 'TOOL', toolCallId: 'tc2',
    }));
    expect(messageRepo.logicalDeleteById).not.toHaveBeenCalled();
    messageRepo.selectMessagesAfterId.mockResolvedValue([]);
    expect(await service.cleanupIncompleteTailAfterId(11, 0)).toBe(0);

    messageRepo.findById.mockResolvedValue({ id: 3, sessionId: 11, role: 'USER', content: 'old' });
    messageRepo.selectLastUserMessage.mockResolvedValue({ id: 3, sessionId: 11, role: 'USER', content: 'old' });
    await service.editMessageAndTruncate(11, 3, 'new', ['img']);
    expect(messageRepo.logicalDeleteAfter).toHaveBeenCalled();
    sessionRepo.findById.mockResolvedValue({ id: 11, phase: 'WAITING_APPROVAL' });
    expect(await service.restoreRunningAfterApproval(11)).toBe(true);
    await service.save({ id: 12, title: 'x' } as never);
    await service.updateField(11, 'status', 'ACTIVE');
    await service.updateField(11, 'phase', 'RUNNING');
    messageRepo.selectLast.mockResolvedValue({ id: 9, sessionId: 11 });
    await service.markLastMessageFinished(11);
    await service.getMaxMessageId(11);
  });
});

describe('SessionService.markLastMessageFinished', () => {
  it('刷新助手 / 工具消息的 updated_at，但跳过 USER 消息', async () => {
    const { service, messageRepo } = makeService();

    // 取消命中工具阶段 / 首轮失败时助手消息未落库，最后一条正是 USER：
    // 终态刷新不能写它，否则运行轨迹把该 run 误判成编辑重发（V029：updated_at 仅编辑时填充）
    messageRepo.selectLast.mockResolvedValue({ id: 7, sessionId: 11, role: 'USER', createdAt: '2026-10-09 10:00:00' });
    await service.markLastMessageFinished(11);
    expect(messageRepo.updateById).not.toHaveBeenCalled();

    // 助手消息照旧刷新：消息轮次要拿它当「任务结束时刻」
    messageRepo.selectLast.mockResolvedValue({ id: 8, sessionId: 11, role: 'ASSISTANT', createdAt: '2026-10-09 10:00:00' });
    await service.markLastMessageFinished(11);
    expect(messageRepo.updateById).toHaveBeenCalledTimes(1);
    const written = vi.mocked(messageRepo.updateById).mock.calls[0][0] as { id: number; updatedAt?: string | null };
    expect(written.id).toBe(8);
    expect(written.updatedAt).not.toBeNull();

    // 没有消息时不动
    messageRepo.selectLast.mockResolvedValue(null);
    await service.markLastMessageFinished(11);
    expect(messageRepo.updateById).toHaveBeenCalledTimes(1);
  });
});

describe('SessionActivityHeartbeat', () => {
  it('throttles touches and clears', async () => {
    const sessionService = { touchLastActivity: vi.fn(async () => undefined) };
    const hb = new SessionActivityHeartbeat(sessionService as never);
    hb.touch(null);
    hb.touch(1);
    hb.touch(1);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(1);
    hb.clear(1);
    hb.clear(null);
  });
});

describe('SessionService.markInterruptedIfActive', () => {
  it('marks only while the session is still in a running phase', async () => {
    const { service, sessionRepo } = makeService();

    expect(await service.markInterruptedIfActive(11)).toBe(true);
    expect(sessionRepo.markPhaseIfIn).toHaveBeenCalledWith(11, 'RESUMING', ['RUNNING', 'RESUMING']);

    // CAS 未命中（执行已写入终态）时返回 false，绝不覆盖终态。
    sessionRepo.markPhaseIfIn.mockResolvedValue(0);
    expect(await service.markInterruptedIfActive(11)).toBe(false);
  });
});

describe('TaskTerminalService', () => {
  it('finishes running session and ignores already terminal', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 1, userId: 7, phase: 'RUNNING' })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => ({ id: 9 })), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect(sessionService.updatePhase).toHaveBeenCalledWith(1, 'COMPLETED');
    sessionService.getSession.mockResolvedValue({ id: 1, phase: 'FAILED' });
    await svc.finishExecution(1, 7, 'COMPLETED', 'exec-2');
    await expect(svc.finishExecution(1, 7, 'RUNNING', 'x')).rejects.toThrow(/Unsupported/);
  });

  it('publishes tree signals for the completing session itself (main task)', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 1, userId: 7, phase: 'RUNNING', sessionType: 'NORMAL' })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => ({ id: 9 })), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect(tree.publish).toHaveBeenCalledWith(1);
  });

  it('publishes tree signals for the parent when a side task finishes', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 2, userId: 7, phase: 'RUNNING', sessionType: 'SIDE_TASK', parentSessionId: 1 })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => ({ id: 9 })), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn(), publishAtRoot: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(2, 7, 'COMPLETED', 'exec-1');
    // 深层边路终态：信号沿父链上溯到根（publishAtRoot），不再按直接父键发
    expect(tree.publishAtRoot).toHaveBeenCalledWith(2);
    expect(tree.publish).not.toHaveBeenCalled();
  });

  it('does not publish tree signals for subagent completion', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 3, userId: 7, phase: 'RUNNING', sessionType: 'SUBAGENT', parentSessionId: 1 })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => ({ id: 9 })), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(3, 7, 'COMPLETED', 'exec-1');
    expect(tree.publish).not.toHaveBeenCalled();
  });

  it('weixin channel terminal push carries unread=false', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 647, userId: 7, phase: 'RUNNING', sessionType: 'NORMAL', projectKey: 'weixin-bot' })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => null), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(647, 7, 'COMPLETED', 'exec-1');
    expect(registry.sendWithResult).toHaveBeenCalledWith(7, expect.objectContaining({
      data: expect.objectContaining({ unread: false }),
    }));
  });

  it('feishu channel terminal push carries unread=false', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 648, userId: 7, phase: 'RUNNING', sessionType: 'NORMAL', projectKey: 'feishu-1-private-2' })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => null), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(648, 7, 'COMPLETED', 'exec-1');
    expect(registry.sendWithResult).toHaveBeenCalledWith(7, expect.objectContaining({
      data: expect.objectContaining({ unread: false }),
    }));
  });

  it('getMessagesByRounds pulls a tool result whose id sits past the page', async () => {
    const { service, messageRepo } = makeService();
    messageRepo.findById.mockResolvedValue({ id: 3, sessionId: 11, role: 'USER' });
    messageRepo.selectUserStarts.mockResolvedValue([{ id: 1, role: 'USER' }]);
    messageRepo.selectRange.mockResolvedValue([
      { id: 1, sessionId: 11, role: 'USER', content: 'q1' },
      {
        id: 2, sessionId: 11, role: 'ASSISTANT', content: 'a1',
        toolCalls: JSON.stringify([{ id: 'c2', name: 'shell' }]),
      },
    ]);
    messageRepo.selectToolMessagesByCallIds.mockResolvedValue([
      { id: 13, sessionId: 11, role: 'TOOL', content: '[系统] 该工具调用没有对应输出', toolCallId: 'c2' },
    ]);

    const page = await service.getMessagesByRounds(11, 5, 3);
    expect(messageRepo.selectToolMessagesByCallIds).toHaveBeenCalledWith(11, ['c2'], null, null);
    expect(page.messages.map((message) => message.id)).toEqual([1, 2, 13]);
    expect(page.messages[2].toolCallId).toBe('c2');
  });

  it('non-weixin channel terminal push keeps unread=true', async () => {
    const sessionService = {
      getSession: vi.fn(async () => ({ id: 1, userId: 7, phase: 'RUNNING', sessionType: 'NORMAL', projectKey: 'demo' })),
      updatePhase: vi.fn(),
      updateRuntimeStatus: vi.fn(),
      markLastMessageFinished: vi.fn(),
    };
    const registry = { send: vi.fn(), sendWithResult: vi.fn(async () => ({ delivered: true })) };
    const delivery = { prepare: vi.fn(async () => null), resolveWebSocket: vi.fn() };
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(1, 7, 'COMPLETED', 'exec-1');
    expect(registry.sendWithResult).toHaveBeenCalledWith(7, expect.objectContaining({
      data: expect.objectContaining({ unread: true }),
    }));
  });
});

describe('GitOperationService', () => {
  it('rejects clone URLs that carry credentials', () => {
    expect(() => GitUrlParser.validate('https://oauth2:secret@git.example.com/a.git')).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('https://L5qE9pn6816goV22Qvrr@git.acg.team/a/b.git')).toThrow(BusinessException);
    expect(() => GitUrlParser.validate('https://git.acg.team/a/b.git')).not.toThrow();
  });

  it('provides credentials via GIT_ASKPASS instead of the clone URL', async () => {
    const dir = useTmpDir('clone-');
    const scripts: string[] = [];
    const git = new GitOperationService(
      { getTokenMapByUser: async () => ({ 'git.acg.team': 'tok-value' }) },
      {
        resolveGitAskpassScript: (userId, sessionId) => {
          const script = join(dir, `git-askpass-${userId}-${sessionId}.sh`);
          scripts.push(script);
          return script;
        },
      },
    );
    // 远端不可达即可，无需真实网络：`https://` 指向本地关闭端口使 clone 毫秒级失败
    // （`*.invalid` 域名在本机 HTTP(S)_PROXY 下要 5-10s 才失败，超过 vitest 5s 超时）。
    // 本用例断言的是「凭证走 GIT_ASKPASS 脚本而非 URL」，与远端是否真实存在无关。
    const result = await git.clone('https://127.0.0.1:1/repo.git', null, join(dir, 'r'), 1, 9);
    expect(result.success).toBe(false);
    expect(scripts).toHaveLength(1);
    expect(existsSync(scripts[0])).toBe(true);
    expect(readFileSync(scripts[0], 'utf8')).toContain('GIT_TOKEN_');
  });

  it('clones anonymously when the user has no credentials', async () => {
    const dir = useTmpDir('clone-');
    const git = new GitOperationService(
      { getTokenMapByUser: async () => ({}) },
      { resolveGitAskpassScript: () => join(dir, 'unused.sh') },
    );
    // 同上：`https://` 指向本地关闭端口使 clone 立即失败，避开代理下 `*.invalid` 的 5-10s 握手等待。
    const result = await git.clone('https://127.0.0.1:1/repo.git', null, join(dir, 'r'), 1, 9);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
