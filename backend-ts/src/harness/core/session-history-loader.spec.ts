import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionContext } from './agent-execution-context.js';
import { SessionHistoryLoader } from './session-history-loader.js';

function makeLoader() {
  const sessionService = {
    getMessagesAfterId: vi.fn(async () => []),
    getFirstUserStamp: vi.fn(async () => null),
    getLastUserMessage: vi.fn(async () => null),
    getPreviousUserStamp: vi.fn(async () => null),
  };
  const contextManager = {
    prependSessionSummary: vi.fn((summary: unknown, incremental: unknown, hint: unknown) => (
      [{ role: 'user', content: `summary=${String(summary)} hint=${String(hint)}` }]
    )),
  };
  const archive = { buildArchiveHint: vi.fn(() => 'ARCHIVE-HINT') };
  const loader = new SessionHistoryLoader(
    sessionService as never, contextManager as never, archive as never,
  );
  return { loader, contextManager, archive };
}

function contextOf(userId: number, runtimeUserId: number | null): AgentExecutionContext {
  const context = new AgentExecutionContext();
  context.sessionId = 11;
  context.userId = userId;
  context.runtimeUserId = runtimeUserId;
  context.executionMode = 'CLOUD';
  return context;
}

const EMPTY_HISTORY = { snapshotMessageIds: [], normalizedEntities: [], persistedMessages: [] };

describe('SessionHistoryLoader 归档提示身份口径（技术方案 2026-11-04 D6）', () => {
  it('运行身份 == 会话归属时注入归档回读提示', async () => {
    const { loader, contextManager, archive } = makeLoader();
    await loader.applyHistory(contextOf(17, 17), 'summary', EMPTY_HISTORY);
    expect(archive.buildArchiveHint).toHaveBeenCalledWith('CLOUD', 17, 11);
    expect(contextManager.prependSessionSummary).toHaveBeenCalledWith(
      'summary', [], 'ARCHIVE-HINT', null,
    );
  });

  it('非归属身份执行时不注入（归档目录仍归 owner，提示只会误导）', async () => {
    const { loader, contextManager, archive } = makeLoader();
    await loader.applyHistory(contextOf(17, 67), 'summary', EMPTY_HISTORY);
    expect(archive.buildArchiveHint).not.toHaveBeenCalled();
    expect(contextManager.prependSessionSummary).toHaveBeenCalledWith(
      'summary', [], null, null,
    );
  });
});

describe('SessionHistoryLoader 任务台账 notice（技术方案 2026-11-25 §3.2.3 刷新点 1）', () => {
  function makeMapperLoader(mapper: unknown) {
    const sessionService = {
      getMessagesAfterId: vi.fn(async () => []),
      getLastUserMessage: vi.fn(async () => null),
      getPreviousUserStamp: vi.fn(async () => null),
    };
    const contextManager = {
      prependSessionSummary: vi.fn((_summary: unknown, incremental: unknown, hint: unknown) => (
        [{ role: 'user', content: `summary hint=${String(hint)}` }]
      )),
    };
    const archive = { buildArchiveHint: vi.fn(() => 'ARCHIVE-HINT') };
    const loader = new SessionHistoryLoader(
      sessionService as never, contextManager as never, archive as never, mapper as never,
    );
    return { loader, contextManager };
  }

  it('applyHistory 后 notice 以 mapper 数据重建（含 id/status）', async () => {
    const mapper = {
      listBySession: vi.fn(async () => [
        { id: 12, sessionId: 11, content: '任务 A', status: 'completed', sortOrder: 0 },
        { id: 13, sessionId: 11, content: '任务 B', status: 'in_progress', sortOrder: 1 },
      ]),
    };
    const { loader, contextManager } = makeMapperLoader(mapper);
    const context = contextOf(17, 17);
    await loader.applyHistory(context, 'summary', EMPTY_HISTORY);
    expect(mapper.listBySession).toHaveBeenCalledWith(11);
    expect(context.todoStateNotice).toContain('#12 completed 任务 A');
    expect(context.todoStateNotice).toContain('#13 in_progress 任务 B');
    expect(context.todoStateNotice).toContain('进度：1/2 已完成。');
    // 历史装载不受影响
    expect(contextManager.prependSessionSummary).toHaveBeenCalled();
    expect(context.messages.length).toBeGreaterThan(0);
  });

  it('mapper 无待办 → notice 为 null', async () => {
    const mapper = { listBySession: vi.fn(async () => []) };
    const { loader } = makeMapperLoader(mapper);
    const context = contextOf(17, 17);
    await loader.applyHistory(context, 'summary', EMPTY_HISTORY);
    expect(context.todoStateNotice).toBeNull();
  });

  it('mapper 抛错 → 降级 null 不抛出，历史装载不受影响', async () => {
    const mapper = { listBySession: vi.fn(async () => { throw new Error('db down'); }) };
    const { loader, contextManager } = makeMapperLoader(mapper);
    const context = contextOf(17, 17);
    await loader.applyHistory(context, 'summary', EMPTY_HISTORY);
    expect(context.todoStateNotice).toBeNull();
    expect(contextManager.prependSessionSummary).toHaveBeenCalled();
  });

  it('未注入 mapper（可选依赖缺省）→ notice 保持 null，既有行为不变', async () => {
    const { loader } = makeLoader();
    const context = contextOf(17, 17);
    await loader.applyHistory(context, 'summary', EMPTY_HISTORY);
    expect(context.todoStateNotice).toBeNull();
  });
});
