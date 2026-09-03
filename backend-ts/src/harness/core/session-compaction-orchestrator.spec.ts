import { describe, expect, it, vi } from 'vitest';
import { SessionCompactionOrchestrator } from './session-compaction-orchestrator.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import type { Message, SessionCompaction } from '../deps.js';

function record(boundary: number, count: number): SessionCompaction {
  return { id: 1, sessionId: 42, lastCompactedMsgId: boundary, compactCount: count, summaryText: 'old' };
}

function entityMessages(): Message[] {
  return [
    { id: 11, sessionId: 42, role: 'USER', content: 'a' },
    { id: 15, sessionId: 42, role: 'ASSISTANT', content: 'b', thinkingContent: 't' },
    { id: 20, sessionId: 42, role: 'ASSISTANT', content: 'c' },
    { id: 25, sessionId: 42, role: 'TOOL', content: 'after-new-boundary' },
  ];
}

function history(messages: Message[]) {
  return {
    snapshotMessageIds: messages.map((m) => m.id!),
    normalizedEntities: messages,
    persistedMessages: messages.map((m) => PersistedChatMessage.from(m.id!, m.content ?? '', { role: m.role!.toLowerCase(), content: m.content ?? '' })),
  };
}

function compactionResult() {
  return {
    summaryText: 'new-summary',
    expectedOldBoundary: 10,
    newLastCompactedMessageId: 20,
    boundaryContentSnapshot: 'c',
    compactedCount: 3,
    promptTokens: 100,
    cachedTokens: null,
    completionTokens: 50,
    summaryTokens: 30,
    savedTokens: 0,
    beforeRequestTokens: 900,
    durationMs: 5,
  };
}

function setup(deps: {
  loadValidatedCalls: Array<SessionCompaction | null>;
  histories: ReturnType<typeof history>[];
  persisted: boolean;
  compactResult: ReturnType<typeof compactionResult> | null;
}) {
  const sessionCompactionService = {
    loadValidated: vi.fn(),
    boundaryOf: (r: SessionCompaction | null | undefined) => (r == null || r.lastCompactedMsgId == null ? 0 : Number(r.lastCompactedMsgId)),
    persist: vi.fn(async () => deps.persisted),
  };
  const sessionCompactionEventService = { record: vi.fn(async () => ({ id: 9 })) };
  const sessionHistoryLoader = {
    loadHistoryAfterBoundary: vi.fn(),
    applyHistory: vi.fn(),
  };
  const contextManager = { compactSession: vi.fn(async () => deps.compactResult) };
  const sessionService = { clearContextAnchor: vi.fn(async () => {}), updateContextTokens: vi.fn(async () => {}) };
  const activeContextCalculator = { estimateRequestTokens: vi.fn(() => 100) };
  const promptEngine = { buildRequest: vi.fn(async () => ({ messages: [] })) };
  const compactionArchiveService = { writeArchive: vi.fn() };
  const orchestrator = new SessionCompactionOrchestrator(
    sessionCompactionService as never,
    sessionCompactionEventService as never,
    sessionHistoryLoader as never,
    contextManager as never,
    sessionService as never,
    activeContextCalculator as never,
    promptEngine as never,
    compactionArchiveService as never,
  );
  sessionCompactionService.loadValidated.mockImplementation(async () => deps.loadValidatedCalls.shift() ?? null);
  sessionHistoryLoader.loadHistoryAfterBoundary.mockImplementation(async () => deps.histories.shift() ?? history([]));
  const context = new AgentExecutionContext();
  context.sessionId = 42;
  context.userId = 7;
  context.executionMode = 'CLOUD';
  const listener = { onCompactionEnd: vi.fn(), onCompactionPersisted: vi.fn(), onContextWindow: vi.fn() };
  return { orchestrator, context, listener, compactionArchiveService, sessionCompactionEventService };
}

function runCompact(setupResult: ReturnType<typeof setup>) {
  return setupResult.orchestrator.compact(
    42,
    setupResult.context,
    { messages: [] },
    setupResult.listener as never,
    { enabled: true } as never,
    false,
    null,
    900,
  );
}

describe('SessionCompactionOrchestrator compaction archive', () => {
  it('writesArchiveWithDbSeqAndBoundaryRangeAfterAdvanced', async () => {
    const messages = entityMessages().filter((m) => m.id! <= 20);
    const s = setup({
      loadValidatedCalls: [record(10, 1), record(20, 2)],
      histories: [history(messages), history([])],
      persisted: true,
      compactResult: compactionResult(),
    });
    const advanced = await runCompact(s);
    expect(advanced).toBe(true);
    expect(s.compactionArchiveService.writeArchive).toHaveBeenCalledOnce();
    const [mode, userId, sessionId, seq, archived] = s.compactionArchiveService.writeArchive.mock.calls[0];
    expect(mode).toBe('CLOUD');
    expect(userId).toBe(7);
    expect(sessionId).toBe(42);
    expect(seq).toBe(2);
    expect(archived.map((m: Message) => m.id)).toEqual([11, 15, 20]);
    expect(s.sessionCompactionEventService.record).toHaveBeenCalledOnce();
    expect(s.listener.onCompactionPersisted).toHaveBeenCalledOnce();
  });

  it('doesNotWriteArchiveWhenCasPersistFails', async () => {
    const s = setup({
      loadValidatedCalls: [record(10, 1), record(10, 1)],
      histories: [history(entityMessages()), history([])],
      persisted: false,
      compactResult: compactionResult(),
    });
    const advanced = await runCompact(s);
    expect(advanced).toBe(false);
    expect(s.compactionArchiveService.writeArchive).not.toHaveBeenCalled();
    expect(s.sessionCompactionEventService.record).not.toHaveBeenCalled();
    expect(s.listener.onCompactionEnd).toHaveBeenCalledWith('session', 0, 0, 5);
  });

  it('doesNotWriteArchiveWhenAnotherThreadAdvancedBeyondCandidate', async () => {
    // CAS 失败且他人推进到了更大边界：advanced=false（本线程不是赢家），不写归档
    const s = setup({
      loadValidatedCalls: [record(10, 1), record(30, 2)],
      histories: [history(entityMessages()), history([])],
      persisted: false,
      compactResult: compactionResult(),
    });
    const advanced = await runCompact(s);
    expect(advanced).toBe(false);
    expect(s.compactionArchiveService.writeArchive).not.toHaveBeenCalled();
  });
});
