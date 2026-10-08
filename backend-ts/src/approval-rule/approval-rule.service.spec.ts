import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalRuleService } from './approval-rule.service.js';
import type { ApprovalRuleRepository } from './approval-rule.repository.js';
import type { ApprovalRuleRow } from './types.js';
import type { ApprovalHint } from '../harness/approval/approval-hint.js';

function row(overrides: Partial<ApprovalRuleRow>): ApprovalRuleRow {
  return {
    id: 1,
    userId: 9,
    scope: 'USER',
    sessionId: null,
    ruleType: 'SHELL_PREFIX',
    ruleValue: 'npm run',
    hitCount: 0,
    lastHitAt: null,
    enabled: 1,
    createdAt: '2026-10-07 10:00:00',
    updatedAt: '2026-10-07 10:00:00',
    ...overrides,
  };
}

describe('ApprovalRuleService', () => {
  let repo: {
    listEnabledForMatch: ReturnType<typeof vi.fn>;
    incrementHit: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findBySessionAndValue: ReturnType<typeof vi.fn>;
    updateEnabled: ReturnType<typeof vi.fn>;
    updateValue: ReturnType<typeof vi.fn>;
    deleteById: ReturnType<typeof vi.fn>;
    listByUser: ReturnType<typeof vi.fn>;
    countByUser: ReturnType<typeof vi.fn>;
    pageAdmin: ReturnType<typeof vi.fn>;
  };
  let settingReader: { getValue: ReturnType<typeof vi.fn> };
  let sessionLookup: { getUserId: ReturnType<typeof vi.fn> };
  let service: ApprovalRuleService;

  beforeEach(() => {
    repo = {
      listEnabledForMatch: vi.fn().mockResolvedValue([]),
      incrementHit: vi.fn().mockResolvedValue(undefined),
      insert: vi.fn().mockResolvedValue(100),
      findById: vi.fn(),
      findBySessionAndValue: vi.fn().mockResolvedValue(null),
      updateEnabled: vi.fn().mockResolvedValue(undefined),
      updateValue: vi.fn().mockResolvedValue(undefined),
      deleteById: vi.fn().mockResolvedValue(undefined),
      listByUser: vi.fn().mockResolvedValue([]),
      countByUser: vi.fn().mockResolvedValue(0),
      pageAdmin: vi.fn().mockResolvedValue({ records: [], total: 0, page: 1, size: 20 }),
    };
    settingReader = { getValue: vi.fn().mockResolvedValue('') };
    sessionLookup = { getUserId: vi.fn().mockResolvedValue(9) };
    service = new ApprovalRuleService(
      repo as unknown as ApprovalRuleRepository,
      settingReader,
      sessionLookup,
    );
  });

  // ---------- match ----------

  it('matchReturnsNullWithoutUserId', async () => {
    expect(await service.match({ userId: null, sessionId: 7, toolName: 'shell', argumentsJson: '{"command":"npm run build"}' })).toBeNull();
    expect(repo.listEnabledForMatch).not.toHaveBeenCalled();
  });

  it('matchHitsSessionRuleBeforeUserRule', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 2, scope: 'USER', ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
      row({ id: 1, scope: 'SESSION', sessionId: 7, ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
    ]);
    const hit = await service.match({ userId: 9, sessionId: 7, toolName: 'shell', argumentsJson: '{"command":"npm run build"}' });
    expect(hit).toEqual({ ruleId: 1, ruleValue: 'npm run' });
  });

  it('matchHitsUserRuleWhenNoSessionRule', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 2, scope: 'USER', ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
    ]);
    const hit = await service.match({ userId: 9, sessionId: 7, toolName: 'shell', argumentsJson: '{"command":"npm run build"}' });
    expect(hit).toEqual({ ruleId: 2, ruleValue: 'npm run' });
  });

  it('matchPrefersExactOverPrefix', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 3, ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
      row({ id: 4, ruleType: 'SHELL_EXACT', ruleValue: 'npm run build' }),
    ]);
    const hit = await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"npm run build"}' });
    expect(hit).toEqual({ ruleId: 4, ruleValue: 'npm run build' });
  });

  it('matchRespectsWordBoundary', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
    ]);
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"npm runx build"}' })).toBeNull();
  });

  it('matchNormalizesEnvPrefixBeforeComparing', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
    ]);
    const hit = await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"FOO=bar npm run build"}' });
    expect(hit).toEqual({ ruleId: 1, ruleValue: 'npm run' });
  });

  it('matchFailsEvenWhenRuleExistsWhenCommandContainsDenyToken', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ ruleType: 'SHELL_EXACT', ruleValue: 'rm x' }),
    ]);
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"rm x"}' })).toBeNull();
    // 前缀规则的漏网兜底：git push 规则不放行 git push --force
    repo.listEnabledForMatch.mockResolvedValue([
      row({ ruleType: 'SHELL_PREFIX', ruleValue: 'git push' }),
    ]);
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"git push --force"}' })).toBeNull();
  });

  it('matchMcpToolByFullName', async () => {
    repo.listEnabledForMatch.mockResolvedValue([
      row({ ruleType: 'MCP_TOOL', ruleValue: 'mcp__fs__read' }),
    ]);
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'mcp__fs__read', argumentsJson: '{}' }))
      .toEqual({ ruleId: 1, ruleValue: 'mcp__fs__read' });
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'mcp__fs__write', argumentsJson: '{}' })).toBeNull();
  });

  it('matchSkipsNonRuleableTools', async () => {
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'write_file', argumentsJson: '{"path":"x"}' })).toBeNull();
    expect(repo.listEnabledForMatch).not.toHaveBeenCalled();
  });

  it('matchOnlySeesOwnRules', async () => {
    // repository 层按 user_id 过滤——service 只透传 userId，这里断言透传正确
    repo.listEnabledForMatch.mockResolvedValue([]);
    await service.match({ userId: 11, sessionId: 7, toolName: 'shell', argumentsJson: '{"command":"npm run"}' });
    expect(repo.listEnabledForMatch).toHaveBeenCalledWith(11, 7);
  });

  it('matchDegradesToNullOnRepoFailure', async () => {
    repo.listEnabledForMatch.mockRejectedValue(new Error('db down'));
    expect(await service.match({ userId: 9, sessionId: null, toolName: 'shell', argumentsJson: '{"command":"npm run"}' })).toBeNull();
  });

  it('recordHitIsFireAndForget', async () => {
    repo.incrementHit.mockRejectedValue(new Error('boom'));
    expect(() => service.recordHit(1)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });

  // ---------- buildHint ----------

  it('buildHintReturnsNullForDenyTokenCommand', async () => {
    expect(await service.buildHint('shell', '{"command":"rm -rf x"}')).toBeNull();
  });

  it('buildHintIncludesAdminExtendedDenyTokens', async () => {
    settingReader.getValue.mockResolvedValue('kubectl,helm');
    expect(await service.buildHint('shell', '{"command":"kubectl get pods"}')).toBeNull();
    expect(await service.buildHint('shell', '{"command":"kubectl-np get pods"}')).not.toBeNull();
  });

  // ---------- alwaysAllow ----------

  it('createSessionRuleFromAlwaysAllowCreatesSessionRule', async () => {
    const hint: ApprovalHint = { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: 'x' };
    await service.createSessionRuleFromAlwaysAllow(9, 7, hint);
    expect(repo.findBySessionAndValue).toHaveBeenCalledWith(7, 'SHELL_PREFIX', 'npm run');
    expect(repo.insert).toHaveBeenCalledWith({ userId: 9, scope: 'SESSION', sessionId: 7, ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' });
  });

  it('createSessionRuleFromAlwaysAllowIsIdempotent', async () => {
    repo.findBySessionAndValue.mockResolvedValue(row({ scope: 'SESSION', sessionId: 7 }));
    await service.createSessionRuleFromAlwaysAllow(9, 7, { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: 'x' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('createSessionRuleFromAlwaysAllowIgnoresWrongOwner', async () => {
    sessionLookup.getUserId.mockResolvedValue(77);
    await service.createSessionRuleFromAlwaysAllow(9, 7, { ruleType: 'SHELL_PREFIX', ruleValue: 'npm run', label: 'x' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('createSessionRuleFromAlwaysAllowIgnoresInvalidHint', async () => {
    await service.createSessionRuleFromAlwaysAllow(9, 7, { ruleType: 'PATH_PREFIX' as never, ruleValue: '/tmp', label: 'x' });
    await service.createSessionRuleFromAlwaysAllow(9, 7, { ruleType: 'SHELL_PREFIX', ruleValue: '  ', label: 'x' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  // ---------- user CRUD ----------

  it('createUserRuleNormalizesShellPrefixInput', async () => {
    repo.findById.mockResolvedValue(row({ ruleValue: 'git push' }));
    const vo = await service.createUserRule(9, { ruleType: 'SHELL_PREFIX', ruleValue: 'git push origin main' });
    expect(repo.insert).toHaveBeenCalledWith({ userId: 9, scope: 'USER', sessionId: null, ruleType: 'SHELL_PREFIX', ruleValue: 'git push' });
    expect(vo.ruleValue).toBe('git push');
  });

  it('createUserRuleRejectsDenylistValue', async () => {
    await expect(service.createUserRule(9, { ruleType: 'SHELL_EXACT', ruleValue: 'rm x' })).rejects.toMatchObject({ code: 3038 });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('createUserRuleRejectsInvalidTypeAndEmptyValue', async () => {
    await expect(service.createUserRule(9, { ruleType: 'PATH_PREFIX', ruleValue: '/tmp' })).rejects.toMatchObject({ code: 2001 });
    await expect(service.createUserRule(9, { ruleType: 'SHELL_PREFIX', ruleValue: '   ' })).rejects.toMatchObject({ code: 2001 });
    await expect(service.createUserRule(9, { ruleType: 'MCP_TOOL', ruleValue: 'not-mcp' })).rejects.toMatchObject({ code: 2001 });
  });

  it('updateUserRuleTogglesEnabled', async () => {
    repo.findById.mockResolvedValueOnce(row({ enabled: 0 })).mockResolvedValueOnce(row({ enabled: 1 }));
    const vo = await service.updateUserRule(9, 1, { enabled: true });
    expect(repo.updateEnabled).toHaveBeenCalledWith(1, true);
    expect(vo.enabled).toBe(true);
  });

  it('updateUserRuleRenamesValueWithRenormalization', async () => {
    repo.findById.mockResolvedValue(row({ ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }));
    repo.findById.mockResolvedValueOnce(row({ ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }));
    await service.updateUserRule(9, 1, { ruleValue: 'git push origin main' });
    expect(repo.updateValue).toHaveBeenCalledWith(1, 'SHELL_PREFIX', 'git push');
  });

  it('updateUserRuleReturns404ForOthersAndSessionRules', async () => {
    repo.findById.mockResolvedValue(row({ userId: 77 }));
    await expect(service.updateUserRule(9, 1, { enabled: false })).rejects.toMatchObject({ code: 3037 });
    repo.findById.mockResolvedValue(row({ scope: 'SESSION', sessionId: 7 }));
    await expect(service.updateUserRule(9, 1, { enabled: false })).rejects.toMatchObject({ code: 3037 });
    repo.findById.mockResolvedValue(null);
    await expect(service.updateUserRule(9, 1, { enabled: false })).rejects.toMatchObject({ code: 3037 });
    repo.findById.mockResolvedValue(row({ userId: 77 }));
    await expect(service.removeUserRule(9, 1)).rejects.toMatchObject({ code: 3037 });
  });

  it('listUserRulesOrdersByHitCountFromRepo', async () => {
    repo.listByUser.mockResolvedValue([
      row({ id: 2, hitCount: 5 }),
      row({ id: 1, hitCount: 1 }),
    ]);
    repo.countByUser.mockResolvedValue(2);
    const page = await service.listUserRules(9, {});
    expect(page.total).toBe(2);
    expect(page.records[0].id).toBe(2);
    expect(page.records[0].enabled).toBe(true);
    expect(page.records[0].hitCount).toBe(5);
  });

  it('listUserRulesAppendsSessionRulesOnlyWhenRequested', async () => {
    repo.listByUser.mockResolvedValue([]);
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 5, scope: 'SESSION', sessionId: 7 }),
      row({ id: 6, scope: 'USER' }),
    ]);
    const withSession = await service.listUserRules(9, { includeSession: true, sessionId: 7 });
    expect(withSession.records.map((r) => r.id)).toEqual([5]);
    const withoutSession = await service.listUserRules(9, {});
    expect(withoutSession.records).toEqual([]);
    expect(repo.listEnabledForMatch).toHaveBeenCalledTimes(1);
  });

  it('listUserRulesTotalCoversMergedRecordsWhenAppendingSessionRules', async () => {
    // includeSession=1 时附带的会话规则不在分页口径内：total 与列表都以合并去重后的结果为准
    repo.listByUser.mockResolvedValue([row({ id: 1, scope: 'USER', hitCount: 9 })]);
    repo.countByUser.mockResolvedValue(1);
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 5, scope: 'SESSION', sessionId: 7, ruleValue: 'git push' }),
      row({ id: 6, scope: 'SESSION', sessionId: 7, ruleValue: 'npm run' }),
    ]);
    const page = await service.listUserRules(9, { includeSession: true, sessionId: 7 });
    expect(page.records.map((r) => r.id)).toEqual([1, 5, 6]);
    expect(page.total).toBe(3);

    // scope=SESSION + includeSession：主分页已含 5，追加列表再出现 5/6 —— 按 id 去重、total 与 records 一致
    repo.listByUser.mockResolvedValue([row({ id: 5, scope: 'SESSION', sessionId: 7, ruleValue: 'git push' })]);
    const dup = await service.listUserRules(9, { scope: 'SESSION', includeSession: true, sessionId: 7 });
    expect(dup.records.map((r) => r.id)).toEqual([5, 6]);
    expect(dup.total).toBe(2);
  });

  it('listUserRulesFiltersSessionRulesByRuleTypeWhenAppended', async () => {
    repo.listByUser.mockResolvedValue([]);
    repo.listEnabledForMatch.mockResolvedValue([
      row({ id: 5, scope: 'SESSION', sessionId: 7, ruleType: 'MCP_TOOL', ruleValue: 'mcp__s__t' }),
      row({ id: 6, scope: 'SESSION', sessionId: 7, ruleType: 'SHELL_PREFIX', ruleValue: 'npm run' }),
    ]);
    const filtered = await service.listUserRules(9, { includeSession: true, sessionId: 7, ruleType: 'MCP_TOOL' });
    expect(filtered.records.map((r) => r.id)).toEqual([5]);
    expect(filtered.total).toBe(1);
    const unfiltered = await service.listUserRules(9, { includeSession: true, sessionId: 7 });
    expect(unfiltered.records.map((r) => r.id)).toEqual([5, 6]);
  });
});
