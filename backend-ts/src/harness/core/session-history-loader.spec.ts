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
