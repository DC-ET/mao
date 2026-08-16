import { describe, expect, it, vi } from 'vitest';
import { DuplicateKeyError, SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionRepository } from './session-compaction.repository.js';
import type { MessageRepository, SessionRepository } from './session.repository.js';
import type { Message, SessionCompaction } from './types.js';

function record(id: number, sessionId: number, boundary: number, summary: string): SessionCompaction {
  return { id, sessionId, lastCompactedMsgId: boundary, summaryText: summary };
}

describe('SessionCompactionService', () => {
  const compactionRepo = {
    selectBySessionId: vi.fn(),
    deleteIfBoundaryMatches: vi.fn(),
    updateWithBoundaryCas: vi.fn(),
    insert: vi.fn(),
  } as unknown as SessionCompactionRepository;
  const messageRepo = {
    selectValidBoundaryMessage: vi.fn(),
  } as unknown as MessageRepository;
  const sessionRepo = {
    lockActiveSessionById: vi.fn(),
  } as unknown as SessionRepository;
  const service = new SessionCompactionService(compactionRepo, messageRepo, sessionRepo);

  it('validatesBoundaryOwnershipAndLogicalDeletion', async () => {
    const rec = record(7, 42, 100, 'summary');
    const boundary: Message = { id: 100, sessionId: 42, role: 'ASSISTANT' };
    vi.mocked(compactionRepo.selectBySessionId).mockResolvedValue(rec);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue(boundary);
    expect(await service.loadValidated(42)).toBe(rec);
    expect(compactionRepo.deleteIfBoundaryMatches).not.toHaveBeenCalled();
  });

  it('clearsMissingDeletedOrForeignBoundaryRecord', async () => {
    const rec = record(7, 42, 100, 'summary');
    vi.mocked(compactionRepo.selectBySessionId).mockResolvedValue(rec);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue(null);
    vi.mocked(compactionRepo.deleteIfBoundaryMatches).mockResolvedValue(1);
    expect(await service.loadValidated(42)).toBeNull();
    expect(compactionRepo.deleteIfBoundaryMatches).toHaveBeenCalledWith(7, 42, 100);
  });

  it('clearsBoundaryThatHasNoUsableSummary', async () => {
    vi.mocked(compactionRepo.selectBySessionId).mockResolvedValue(record(7, 42, 100, ' '));
    vi.mocked(compactionRepo.deleteIfBoundaryMatches).mockResolvedValue(1);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockClear();
    expect(await service.loadValidated(42)).toBeNull();
    expect(messageRepo.selectValidBoundaryMessage).not.toHaveBeenCalled();
  });

  it('clearsSummaryWithoutAPositiveBoundary', async () => {
    vi.mocked(compactionRepo.selectBySessionId).mockResolvedValue(record(7, 42, 0, 'orphan summary'));
    vi.mocked(compactionRepo.deleteIfBoundaryMatches).mockResolvedValue(1);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockClear();
    expect(await service.loadValidated(42)).toBeNull();
    expect(messageRepo.selectValidBoundaryMessage).not.toHaveBeenCalled();
  });

  it('existingRecordUsesBoundaryCasAndReportsConflict', async () => {
    const rec = record(7, 42, 100, 'old');
    vi.mocked(sessionRepo.lockActiveSessionById).mockResolvedValue(42);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue({ sessionId: 42, role: 'ASSISTANT', content: 'candidate' });
    vi.mocked(compactionRepo.updateWithBoundaryCas).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    expect(await service.persist(42, rec, 100, 150, 'candidate', 'new', 12, 4, 'gpt-test')).toBe(true);
    expect(await service.persist(42, rec, 100, 150, 'candidate', 'new', 12, 4, 'gpt-test')).toBe(false);
  });

  it('firstInsertConflictDoesNotOverwriteWinner', async () => {
    vi.mocked(sessionRepo.lockActiveSessionById).mockResolvedValue(42);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue({ sessionId: 42, role: 'ASSISTANT', content: 'candidate' });
    vi.mocked(compactionRepo.insert).mockRejectedValue(new DuplicateKeyError());
    vi.mocked(compactionRepo.updateWithBoundaryCas).mockClear();
    expect(await service.persist(42, null, 0, 150, 'candidate', 'new', 12, 4, 'gpt-test')).toBe(false);
    expect(compactionRepo.updateWithBoundaryCas).not.toHaveBeenCalled();
  });

  it('refusesToPersistMissingCandidateBoundary', async () => {
    vi.mocked(sessionRepo.lockActiveSessionById).mockResolvedValue(42);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue(null);
    vi.mocked(compactionRepo.insert).mockClear();
    expect(await service.persist(42, null, 0, 150, 'candidate', 'new', 12, 4, 'gpt-test')).toBe(false);
    expect(compactionRepo.insert).not.toHaveBeenCalled();
  });

  it('refusesStaleSummaryWhenBoundaryMessageWasEditedDuringGeneration', async () => {
    const rec = record(7, 42, 100, 'old');
    vi.mocked(sessionRepo.lockActiveSessionById).mockResolvedValue(42);
    vi.mocked(messageRepo.selectValidBoundaryMessage).mockResolvedValue({
      sessionId: 42, role: 'ASSISTANT', content: 'edited while compacting',
    });
    vi.mocked(compactionRepo.updateWithBoundaryCas).mockClear();
    vi.mocked(compactionRepo.insert).mockClear();
    expect(await service.persist(42, rec, 100, 150, 'original snapshot', 'new', 12, 4, 'gpt-test')).toBe(false);
    expect(compactionRepo.updateWithBoundaryCas).not.toHaveBeenCalled();
    expect(compactionRepo.insert).not.toHaveBeenCalled();
  });
});
