import { describe, expect, it, vi } from 'vitest';
import { SessionService } from './session.service.js';
import { CLOUD_TEMP, compareSessions, isActivePhase } from './util/session-group-key.js';
import type { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';
import type { AgentLookup, Message, Session, UserCommandLookup } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';

/**
 * BUGCHECK（审查新增，非产品代码）：分组展开页 listSessionsByGroup 的 ORDER BY
 * （session.service.ts:302-304）把活跃相位写成 3 个（'RUNNING','RESUMING',
 * 'WAITING_APPROVAL'），漏掉 CANCELLING；而侧边栏预览 compareSessions 用的
 * isActivePhase（session-group-key.ts:233-236，注释明确「组预览排序漏列会把取消中的
 * 会话当空闲排到后面」）和同文件 dashboard SQL（session.service.ts:1519，注释
 * 「运行中口径与 isActivePhase 一致，含 CANCELLING」）都是 4 相位口径。
 * 结果：取消中的会话在预览里排活跃档，展开后掉到空闲档，两视图排序互相矛盾。
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
 */
function makeService() {
  const txDb = {
    insert: vi.fn(async () => 99),
    queryOne: vi.fn(async () => null),
    query: vi.fn(async () => []),
    execute: vi.fn(async () => ({ affectedRows: 1 })),
  };
  const sessionRepo = {
    findById: vi.fn(),
    updateById: vi.fn(),
    updateWhere: vi.fn(),
    updateFields: vi.fn(async () => 1),
    pageSessionsByFilter: vi.fn(),
    count: vi.fn(async () => 0),
    selectMessageSearchCandidates: vi.fn(),
    selectMatchingSessions: vi.fn(async () => []),
    countMatchingSessions: vi.fn(async () => 0),
    selectByIds: vi.fn(async () => []),
    selectPage: vi.fn(async () => ({ records: [], total: 0 })),
    list: vi.fn(async () => []),
    listDescendantSideTasks: vi.fn(async () => []),
    listDescendantSideTasksByRoots: vi.fn(async () => new Map<number, Session[]>()),
    insert: vi.fn(async () => 99),
    lockActiveSessionById: vi.fn(),
    logicalDelete: vi.fn(),
    transaction: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn(txDb)),
  } as unknown as SessionRepository;
  const messageRepo = {
    selectMessagesForSearch: vi.fn(),
    selectHitMessages: vi.fn(async () => []),
    selectRoundStartForMessage: vi.fn(async () => null),
    selectNextUserMessageId: vi.fn(async () => null),
    hasMessageBefore: vi.fn(async () => false),
    selectUserStarts: vi.fn(async () => []),
    selectRange: vi.fn(async () => []),
    selectFirstMatchingMessages: vi.fn(async () => []),
    listBySession: vi.fn(async () => []),
    insert: vi.fn(async () => 199),
    logicalDeleteBySession: vi.fn(),
    findById: vi.fn(),
    logicalDeleteAfter: vi.fn(),
    updateById: vi.fn(),
    selectLastUserMessage: vi.fn(),
    selectValidBoundaryMessage: vi.fn(),
  } as unknown as MessageRepository;
  const agentLookup = { findByIds: vi.fn().mockResolvedValue([]) } as unknown as AgentLookup;
  const fileChangeRepo = { listBySession: vi.fn(async () => []), insert: vi.fn() } as unknown as FileChangeRepository;
  const sessionCompactionService = { deleteBySessionId: vi.fn() } as unknown as SessionCompactionService;
  const sessionCompactionEventService = { deleteBySessionId: vi.fn() } as unknown as SessionCompactionEventService;
  const service = new SessionService(
    sessionRepo,
    messageRepo,
    fileChangeRepo,
    agentLookup,
    {} as PathSandbox,
    {} as EnvironmentInfoProvider,
    {} as UserCommandLookup,
    {} as GitOperationService,
    sessionCompactionService,
    sessionCompactionEventService,
  );
  return { service, sessionRepo };
}

describe('BUGCHECK group page ORDER BY active phases', () => {
  it('sorts CANCELLING as an active phase, matching the sidebar preview', async () => {
    const { service, sessionRepo } = makeService();
    await service.listSessionsByGroup(7, CLOUD_TEMP, null, null, 0, 10);
    const orderSql = vi.mocked(sessionRepo.list).mock.calls[0][2] as string;
    const matched = orderSql.match(/CASE WHEN phase IN \(([^)]*)\)/);
    expect(matched).not.toBeNull();
    const sqlPhases = matched![1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).sort();
    const activePhases = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'].filter(isActivePhase).sort();
    expect(sqlPhases).toEqual(activePhases);
  });

  it('preview comparator really puts a newer CANCELLING above an older RUNNING (control group)', () => {
    const running = { id: 1, phase: 'RUNNING', updatedAt: '2026-10-16 10:00:00', isPinned: 0, status: 'ACTIVE' };
    const cancelling = { id: 2, phase: 'CANCELLING', updatedAt: '2026-10-16 11:00:00', isPinned: 0, status: 'ACTIVE' };
    expect(compareSessions(cancelling as unknown as Session, running as unknown as Session)).toBeLessThan(0);
  });
});
