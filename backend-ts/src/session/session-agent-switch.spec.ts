import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { SessionService } from './session.service.js';
import type { FileChangeRepository, MessageRepository, SessionRepository } from './session.repository.js';
import type { AgentLookup, AgentRef, Session } from './types.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { EnvironmentInfoProvider } from '../harness/core/environment-info.js';
import type { GitOperationService } from './git-operation.service.js';
import type { SessionCompactionService } from './session-compaction.service.js';
import type { SessionCompactionEventService } from './session-compaction-event.service.js';

function makeService(agent: AgentRef | null) {
  const sessionRepo = {
    findById: vi.fn(async (id: number) => (id === 10 ? { id: 10, userId: 7, status: 'ACTIVE' } as Session : null)),
    updateFields: vi.fn(async () => 1),
  } as unknown as SessionRepository;
  const agentLookup = {
    findById: vi.fn(async () => agent),
  } as unknown as AgentLookup;
  const service = new SessionService(
    sessionRepo,
    { listBySession: vi.fn(async () => []) } as unknown as MessageRepository,
    { listBySession: vi.fn(async () => []) } as unknown as FileChangeRepository,
    agentLookup,
    {} as PathSandbox,
    {} as EnvironmentInfoProvider,
    {} as never,
    {} as GitOperationService,
    {} as SessionCompactionService,
    {} as SessionCompactionEventService,
  );
  return { service, sessionRepo, agentLookup };
}

const enabledAgent: AgentRef = { id: 5, name: 'Ops', enabled: 1, clientVisible: 1 };
const hiddenAgent: AgentRef = { id: 6, name: 'Hidden', enabled: 1, clientVisible: 0 };

describe('SessionService updateSessionAgent', () => {
  it('updatesAgentIdWhenTargetIsValid', async () => {
    const { service, sessionRepo } = makeService(enabledAgent);
    await service.updateSessionAgent(10, 5);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(10, { agentId: 5 });
  });

  it('throwsAgentNotFoundWhenTargetMissing', async () => {
    const { service } = makeService(null);
    const err = await service.updateSessionAgent(10, 999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).code).toBe(ErrorCode.AGENT_NOT_FOUND.code);
  });

  it('throwsWhenTargetDisabled', async () => {
    const { service, sessionRepo } = makeService({ id: 7, name: 'Off', enabled: 0 });
    const err = await service.updateSessionAgent(10, 7).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((err as BusinessException).message).toBe('该 Agent 已停用');
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('throwsWhenTargetNotClientVisible', async () => {
    const { service, sessionRepo } = makeService(hiddenAgent);
    const err = await service.updateSessionAgent(10, 6).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BusinessException);
    expect((err as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    expect((err as BusinessException).message).toBe('该 Agent 不对客户端开放');
    expect(sessionRepo.updateFields).not.toHaveBeenCalled();
  });

  it('treatsMissingClientVisibleAsVisible', async () => {
    const { service, sessionRepo } = makeService({ id: 8, name: 'Legacy', enabled: 1 });
    await service.updateSessionAgent(10, 8);
    expect(sessionRepo.updateFields).toHaveBeenCalledWith(10, { agentId: 8 });
  });
});
