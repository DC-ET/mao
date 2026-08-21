import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { SessionService } from './session.service.js';
import { SessionActivityHeartbeat } from './session-activity-heartbeat.js';
import { TaskTerminalService } from './task-terminal.service.js';
import { GitOperationService, injectHttpsToken, maskToken } from './git-operation.service.js';

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
    selectMessagesForSearch: vi.fn(async () => []),
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
  const pathSandbox = { getWorkspaceRoot: () => mkdtempSync(join(tmpdir(), 'ws-')) };
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

  it('createSessionThrowsWhenAgentMissing', async () => {
    const { service, agentLookup } = makeService();
    agentLookup.findById.mockResolvedValue(null);
    await expect(service.createSession(7, 99, 'x')).rejects.toBeInstanceOf(BusinessException);
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
    fileChangeRepo.listBySession.mockResolvedValue([{ messageId: 1, path: 'a.ts' }]);
    await service.getFileChangesBySession(11);
    await service.getFileChangesByMessageIds(11, [1]);
    await service.getFileChangesByMessageIds(11, []);

    messageRepo.listBySession.mockResolvedValue([
      { id: 1, role: 'USER', content: 'q' },
      { id: 2, role: 'ASSISTANT', content: 'a', toolCalls: JSON.stringify([{ id: 'tc1' }]) },
    ]);
    expect(await service.cleanupIncompleteTail(11)).toBeGreaterThan(0);
    messageRepo.selectMessagesAfterId.mockResolvedValue([]);
    expect(await service.cleanupIncompleteTailAfterId(11, 0)).toBe(0);

    messageRepo.findById.mockResolvedValue({ id: 3, sessionId: 11, role: 'USER', content: 'old' });
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
    const tree = { publish: vi.fn() };
    const svc = new TaskTerminalService(sessionService as never, registry as never, delivery as never, tree as never);
    await svc.finishExecution(2, 7, 'COMPLETED', 'exec-1');
    expect(tree.publish).toHaveBeenCalledWith(1);
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
});

describe('GitOperationService helpers', () => {
  it('injects and masks https tokens', () => {
    expect(injectHttpsToken('https://git.example.com/a.git', 'tok')).toContain('oauth2:');
    expect(injectHttpsToken('http://git.example.com/a.git', 'tok')).toBe('http://git.example.com/a.git');
    expect(maskToken('https://oauth2:secret@git.example.com/a.git')).toContain('***');
    expect(maskToken(null)).toBe('');
  });

  it('cloneWithoutCredentials', async () => {
    const git = new GitOperationService({ getTokenMapByUser: async () => ({}) });
    const dir = mkdtempSync(join(tmpdir(), 'clone-'));
    const result = await git.clone('https://example.invalid/repo.git', null, join(dir, 'r'), 1);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
void mkdirSync;
void writeFileSync;
