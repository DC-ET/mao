import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { SessionService, buildSnippet } from './session.service.js';
import type { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';
import type { AgentLookup, Message, Session, UserCommandLookup } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';

function session(id: number, title: string, sessionType: string, agentId: number | null, updatedAt: string): Session {
  return { id, userId: 7, title, sessionType, agentId, updatedAt, phase: 'COMPLETED' };
}

function message(id: number, sessionId: number, content: string | null): Message {
  return { id, sessionId, role: 'USER', content };
}

function makeService() {
  const sessionRepo = {
    findById: vi.fn(),
    updateById: vi.fn(),
    updateWhere: vi.fn(),
    selectMessageSearchCandidates: vi.fn(),
    list: vi.fn(),
  } as unknown as SessionRepository;
  const messageRepo = {
    selectMessagesForSearch: vi.fn(),
  } as unknown as MessageRepository;
  const agentLookup = {
    findByIds: vi.fn().mockResolvedValue([]),
  } as unknown as AgentLookup;
  const service = new SessionService(
    sessionRepo,
    messageRepo,
    {} as FileChangeRepository,
    agentLookup,
    {} as PathSandbox,
    {} as EnvironmentInfoProvider,
    {} as UserCommandLookup,
    {} as GitOperationService,
    {} as SessionCompactionService,
    {} as SessionCompactionEventService,
  );
  return { service, sessionRepo, messageRepo, agentLookup };
}

describe('SessionService archive', () => {
  it('unarchiveSessionSetsStatusActive', async () => {
    const { service, sessionRepo } = makeService();
    const s: Session = { id: 10, userId: 7, status: 'ARCHIVED' };
    vi.mocked(sessionRepo.findById).mockResolvedValue(s);
    await service.unarchiveSession(10);
    expect(s.status).toBe('ACTIVE');
    expect(sessionRepo.updateById).toHaveBeenCalledWith(s);
  });

  it('unarchiveSessionThrowsWhenNotFound', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.findById).mockResolvedValue(null);
    await expect(service.unarchiveSession(99)).rejects.toBeInstanceOf(BusinessException);
  });

  it('restoreRunningAfterApprovalIssuesConditionalUpdateAndReturnsTrue', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.updateWhere).mockResolvedValue(1);
    expect(await service.restoreRunningAfterApproval(10)).toBe(true);
  });

  it('restoreRunningAfterApprovalReturnsFalseWhenConditionalUpdateMisses', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.updateWhere).mockResolvedValue(0);
    expect(await service.restoreRunningAfterApproval(10)).toBe(false);
  });

  it('listSideTasksByParentIdsQueriesValidSideTasks', async () => {
    const { service, sessionRepo } = makeService();
    const side: Session = { id: 20, userId: 7, parentSessionId: 10, sessionType: 'SIDE_TASK' };
    vi.mocked(sessionRepo.list).mockResolvedValue([side]);
    const sides = await service.listSideTasksByParentIds([10, 11]);
    expect(sides).toHaveLength(1);
    expect(sides[0].parentSessionId).toBe(10);
  });

  it('listSideTasksByParentIdsReturnsEmptyForNullInput', async () => {
    const { service } = makeService();
    expect(await service.listSideTasksByParentIds(null)).toEqual([]);
    expect(await service.listSideTasksByParentIds([])).toEqual([]);
  });
});

describe('SessionService message search', () => {
  it('returnsHitSessionWithSnippetAndAgentName', async () => {
    const { service, sessionRepo, messageRepo, agentLookup } = makeService();
    const s = session(1, '修复登录 Bug', 'NORMAL', 9, '2026-08-07 10:30:00');
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([s]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([message(100, 1, '帮我看看登录页面为什么报 500 错误')]);
    vi.mocked(agentLookup.findByIds).mockResolvedValue([{ id: 9, name: '默认 Agent' }]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(1);
    expect(items[0].title).toBe('修复登录 Bug');
    expect(items[0].sessionType).toBe('NORMAL');
    expect(items[0].phase).toBe('COMPLETED');
    expect(items[0].agentName).toBe('默认 Agent');
    expect(items[0].snippet).toContain('登录');
    expect(items[0].updatedAt).toBe('2026-08-07T10:30');
  });

  it('returnsEmptyWhenNoCandidates', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([]);
    expect(await service.searchSessionsByUserMessage(7, '不存在')).toEqual([]);
  });

  it('throwsWhenKeywordBlank', async () => {
    const { service } = makeService();
    await expect(service.searchSessionsByUserMessage(7, '   ')).rejects.toMatchObject({ code: ErrorCode.PARAM_MISSING.code });
  });

  it('throwsWhenKeywordTooLong', async () => {
    const { service } = makeService();
    await expect(service.searchSessionsByUserMessage(7, 'a'.repeat(101))).rejects.toMatchObject({ code: ErrorCode.PARAM_INVALID.code });
  });

  it('escapesLikeWildcardsBeforeQuery', async () => {
    const { service, sessionRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([]);
    await service.searchSessionsByUserMessage(7, '100%_\\bug');
    expect(sessionRepo.selectMessageSearchCandidates).toHaveBeenCalledWith(7, '100\\%\\_\\\\bug');
  });

  it('snippetContainsKeywordWhenKeywordInMiddle', () => {
    const text = `${'a'.repeat(60)}登录页面${'b'.repeat(60)}`;
    const snippet = buildSnippet(text, '登录页面');
    expect(snippet).toContain('登录页面');
    expect(snippet!.startsWith('…')).toBe(true);
    expect(snippet!.endsWith('…')).toBe(true);
    expect(snippet!.length).toBeLessThanOrEqual(82);
  });

  it('rejectsMultimodalFalseHit', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const jsonContent = '[{"type":"text","text":"帮我看看这个图片"},{"type":"image_url","url":"http://x/login.png"}]';
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(2, '图片会话', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([message(200, 2, jsonContent)]);
    expect(await service.searchSessionsByUserMessage(7, 'image_url')).toEqual([]);
  });

  it('acceptsMultimodalTextPart', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    const jsonContent = '[{"type":"text","text":"登录页面报错了"},{"type":"image_url","url":"http://x/a.png"}]';
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(3, '带图会话', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([message(300, 3, jsonContent)]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items).toHaveLength(1);
    expect(items[0].snippet).toContain('登录页面报错了');
    expect(items[0].snippet).not.toContain('image_url');
  });

  it('skipsFalseHitSessionAndKeepsTextHitSession', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([
      session(4, '仅图片', 'NORMAL', null, '2026-08-07 10:00:00'),
      session(5, '文本命中', 'NORMAL', null, '2026-08-07 10:00:00'),
    ]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([
      message(401, 4, '[{"type":"image_url","url":"http://x/登录.png"}]'),
      message(501, 5, '这里提到登录页面'),
    ]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(5);
  });

  it('usesFirstHitMessageForSnippet', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(6, '多条命中', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([
      message(1, 6, '开头 abc登录'),
      message(2, 6, 'xyz登录123'),
    ]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items[0].snippet).toContain('开头');
  });

  it('caseInsensitiveMatchConsistentWithCollation', () => {
    expect(buildSnippet('Login failed for user', 'login')).not.toBeNull();
    expect(buildSnippet('登录 Login 页面', 'login')).not.toBeNull();
    expect(buildSnippet('没有这个单词', 'Login')).toBeNull();
  });

  it('keywordNotInTextReturnsNullSnippet', () => {
    expect(buildSnippet('完全无关的内容', '关键词')).toBeNull();
  });

  it('extractVisibleTextHandlesPlainAndMultimodal', () => {
    const { service } = makeService();
    expect(service.extractVisibleText('纯文本消息')).toBe('纯文本消息');
    expect(service.extractVisibleText('[{"type":"text","text":"文本A"},{"type":"image_url","url":"u"}]')).toBe('文本A');
    expect(service.extractVisibleText(null)).toBeNull();
    expect(service.extractVisibleText('[broken')).toBe('[broken');
    expect(service.extractVisibleText('["登录","500"]')).toBe('["登录","500"]');
    expect(service.extractVisibleText('[1,2,3]')).toBe('[1,2,3]');
    expect(service.extractVisibleText('[1,{"type":"text","text":"abc"}]')).toBe('[1,{"type":"text","text":"abc"}]');
    expect(service.extractVisibleText('[]')).toBe('[]');
  });

  it('skipsMultimodalFalseHitInsideSameSessionAndUsesLaterTextHit', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(14, '先图后文', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([
      message(1, 14, '[{"type":"image_url","url":"http://x/登录.png"}]'),
      message(2, 14, '后续提到了登录页面'),
    ]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(14);
    expect(items[0].snippet).toContain('登录');
    expect(items[0].snippet).not.toContain('image_url');
  });

  it('plainJsonArrayMessageMatchesAsText', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(13, '数组文本', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([message(1, 13, '["登录","500"]')]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items).toHaveLength(1);
    expect(items[0].snippet).toContain('登录');
  });

  it('updatedAtSortComesFromCandidateOrder', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([
      session(10, '较新', 'NORMAL', null, '2026-08-07 12:00:00'),
      session(11, '较旧', 'NORMAL', null, '2026-08-01 09:00:00'),
    ]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([
      message(1, 10, '新的登录问题'),
      message(2, 11, '旧的登录问题'),
    ]);
    const items = await service.searchSessionsByUserMessage(7, '登录');
    expect(items.map((i) => i.id)).toEqual([10, 11]);
  });

  it('emptyGroupingSurvivesNullContentMessages', async () => {
    const { service, sessionRepo, messageRepo } = makeService();
    vi.mocked(sessionRepo.selectMessageSearchCandidates).mockResolvedValue([session(12, '空内容', 'NORMAL', null, '2026-08-07 10:00:00')]);
    vi.mocked(messageRepo.selectMessagesForSearch).mockResolvedValue([message(1, 12, null)]);
    expect(await service.searchSessionsByUserMessage(7, '关键词')).toEqual([]);
  });
});
