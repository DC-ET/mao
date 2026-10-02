import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryExtractionService, extractStoredText, toCandidate } from './memory-extraction.service.js';
import type { MemoryRepository } from './memory.repository.js';
import type { LlmModel } from '../domain/types.js';

const MODEL: LlmModel = { id: 3, name: 'flash', provider: 'openai', status: 1 } as LlmModel;

interface Deps {
  messageRepo: {
    selectLastUserMessage: ReturnType<typeof vi.fn>;
    selectLastAssistantMessage: ReturnType<typeof vi.fn>;
  };
  memoryRepo: MemoryRepository;
  preference: { isAutoCaptureEnabled: ReturnType<typeof vi.fn> };
  settings: { getValue: ReturnType<typeof vi.fn> };
  models: { selectById: ReturnType<typeof vi.fn>; selectDefault: ReturnType<typeof vi.fn> };
  llm: { chat: ReturnType<typeof vi.fn> };
}

function buildDeps(): Deps {
  const memoryRepo = {
    countActive: vi.fn(async () => 0),
    findByHash: vi.fn(async () => null),
    insert: vi.fn(async () => 1),
    touch: vi.fn(async () => undefined),
    updateContent: vi.fn(async () => undefined),
    updateStatus: vi.fn(async () => undefined),
    listActiveForDedup: vi.fn(async () => []),
    listStaleAuto: vi.fn(async () => []),
    listDismissedContents: vi.fn(async () => []),
  } as never as MemoryRepository;
  return {
    messageRepo: {
      selectLastUserMessage: vi.fn(async () => ({ content: '请帮我把输出报告改成中文，以后所有报告都用中文输出，这是长期要求' })),
      selectLastAssistantMessage: vi.fn(async () => ({ content: '好的，之后输出报告都会使用中文。' })),
    },
    memoryRepo,
    preference: { isAutoCaptureEnabled: vi.fn(async () => true) },
    settings: { getValue: vi.fn(async () => '') },
    models: {
      selectById: vi.fn(async () => null),
      selectDefault: vi.fn(async () => MODEL),
    },
    llm: {
      chat: vi.fn(async () => ({ choices: [{ message: { content: '[]' } }] })),
    },
  };
}

function buildService(d: Deps): MemoryExtractionService {
  return new MemoryExtractionService(
    d.messageRepo,
    d.memoryRepo,
    d.preference,
    d.settings,
    d.models,
    d.llm as never,
  );
}

const BASE_INPUT = { sessionId: 11, userId: 7, projectKey: 'mao', workspace: '/ws/mao', agentId: 2 };

async function settle(p: Promise<void>): Promise<void> {
  await p;
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('MemoryExtractionService', () => {
  let d: Deps;

  beforeEach(() => {
    d = buildDeps();
  });

  it('shortCircuitsBelow20CharsWithoutCallingLlm', async () => {
    d.messageRepo.selectLastUserMessage.mockResolvedValue({ content: '好的，谢谢' });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.llm.chat).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('skipsWhenUserOrAssistantMessageMissing', async () => {
    d.messageRepo.selectLastAssistantMessage.mockResolvedValue(null);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.llm.chat).not.toHaveBeenCalled();

    d.messageRepo.selectLastUserMessage.mockResolvedValue(null);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.llm.chat).not.toHaveBeenCalled();
  });

  it('skipsWhenAutoCaptureDisabled', async () => {
    d.preference.isAutoCaptureEnabled.mockResolvedValue(false);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.llm.chat).not.toHaveBeenCalled();
  });

  it('fallsBackToDefaultModelWhenSettingEmpty', async () => {
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.settings.getValue).toHaveBeenCalledWith('memory.extractionModelId');
    expect(d.models.selectDefault).toHaveBeenCalled();
    expect(d.llm.chat).toHaveBeenCalled();
  });

  it('usesConfiguredModelWhenAvailable', async () => {
    d.settings.getValue.mockResolvedValue('9');
    d.models.selectById.mockResolvedValue(MODEL);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.models.selectById).toHaveBeenCalledWith(9);
    expect(d.models.selectDefault).not.toHaveBeenCalled();
  });

  it('abandonsOnInvalidJson', async () => {
    d.llm.chat.mockResolvedValue({ choices: [{ message: { content: '这不是 JSON' } }] });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('acceptsFencedJsonAndEmptyArrayDoesNothing', async () => {
    d.llm.chat.mockResolvedValue({ choices: [{ message: { content: '```json\n[]\n```' } }] });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('abandonsWholeOutputWhenMoreThan3Items', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([1, 2, 3, 4].map((i) => ({ type: 'user', content: `条目${i}` }))) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('countsGarbageElementsTowardItemLimit', async () => {
    // 原始数组 4 个元素（含 1 个垃圾元素）即超过 3 条口径，整体放弃
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([null, { type: 'user', content: '条目一' }, { type: 'user', content: '条目二' }, { type: 'user', content: '条目三' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('dropsOnlyOverlongOrEmptyItems', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify([
            { type: 'user', content: '短'.repeat(121) },
            { type: 'user', content: '   ' },
            { type: 'user', content: '输出报告用中文' },
          ]),
        },
      }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).toHaveBeenCalledTimes(1);
    expect((d.memoryRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0].content).toBe('输出报告用中文');
  });

  it('insertsAutoMemoryWithOriginSession', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', content: '输出报告用中文' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    const inserted = (d.memoryRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted.source).toBe('AUTO');
    expect(inserted.originSessionId).toBe(11);
    expect(inserted.userId).toBe(7);
    expect(inserted.scope).toBe('USER');
  });

  it('activeDedupHitOnlyTouchesUpdatedAt', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', content: '输出报告用中文' }]) } }],
    });
    (d.memoryRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 5, status: 'ACTIVE' });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).toHaveBeenCalledWith(5);
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('dismissedHitIsSkippedAndNeverRevived', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', content: '输出报告用中文' }]) } }],
    });
    (d.memoryRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 5, status: 'DISMISSED' });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('touchesKnownRowOnSemanticHit', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'USER' ? [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }] : []);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'touch', existingId: 12 }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).toHaveBeenCalledWith(12);
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('touchesKnownProjectRowWithinSameProjectGroup', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'PROJECT' ? [{ id: 15, scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' }] : []);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'project', action: 'touch', existingId: 15 }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).toHaveBeenCalledWith(15);
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('updatesKnownRowWithRicherContent', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'USER' ? [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }] : []);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'update', existingId: 12, content: '输出报告一律使用中文，含图表标题' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.updateContent).toHaveBeenCalledTimes(1);
    const [id, content, hash] = (d.memoryRepo.updateContent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(id).toBe(12);
    expect(content).toBe('输出报告一律使用中文，含图表标题');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('fallsBackToTouchWhenUpdatedContentHitsAnotherRowsHash', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'USER' ? [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }] : []);
    (d.memoryRepo.findByHash as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, status: 'ACTIVE' });
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'update', existingId: 12, content: '输出报告一律使用中文' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.updateContent).not.toHaveBeenCalled();
    expect(d.memoryRepo.touch).toHaveBeenCalledWith(12);
  });

  it('dropsCandidateReferencingRowOutsideComparisonSet', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'USER' ? [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }] : []);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'touch', existingId: 99 }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('dropsCandidateReferencingRowFromOtherGroup', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'PROJECT' ? [{ id: 15, scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' }] : []);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'touch', existingId: 15 }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('promptCarriesKnownMemoriesAndIgnoredHints', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'PROJECT'
        ? [{ id: 15, scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' }]
        : [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }]);
    (d.memoryRepo.listDismissedContents as ReturnType<typeof vi.fn>).mockResolvedValue([{ content: '旧的临时偏好' }]);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    const [system, user] = (d.llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0].messages;
    expect(system.content).toContain('"touch"');
    expect(system.content).toContain('<ignored_memories>');
    expect(user.content).toContain('[用户级]');
    expect(user.content).toContain('id:12 输出报告用中文');
    expect(user.content).toContain('[项目级:mao]');
    expect(user.content).toContain('id:15 该仓库测试用 Vitest');
    expect(user.content).toContain('旧的临时偏好');
  });

  it('degradesToExactHashPathWhenKnownLoadFails', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', content: '输出报告用中文' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('evictsStaleAutoRowWhenActiveLimitReachedAndInserts', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'insert', content: '新事实' }]) } }],
    });
    (d.memoryRepo.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    (d.memoryRepo.listStaleAuto as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 5 }]);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.updateStatus).toHaveBeenCalledWith(5, 'DISMISSED');
    expect(d.memoryRepo.insert).toHaveBeenCalledTimes(1);
  });

  it('skipsInsertWhenGroupHasNoEvictableAutoRow', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'insert', content: '新事实' }]) } }],
    });
    (d.memoryRepo.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    (d.memoryRepo.listStaleAuto as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.updateStatus).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('evictsOneStaleRowPerInsertWhenActiveFull', async () => {
    // 协议每轮最多 3 条候选，满载时逐条淘汰一条腾一个名额（淘汰上限 MEMORY_EXTRACT_MAX_ITEMS 随之结构性封顶）
    d.llm.chat.mockResolvedValue({
      choices: [{
        message: {
          content: JSON.stringify([1, 2, 3].map((i) => ({ type: 'user', action: 'insert', content: `事实${i}` }))),
        },
      }],
    });
    (d.memoryRepo.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    let staleId = 40;
    (d.memoryRepo.listStaleAuto as ReturnType<typeof vi.fn>).mockImplementation(async () => [{ id: staleId++ }]);
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.insert).toHaveBeenCalledTimes(3);
    expect((d.memoryRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls).toEqual([[40, 'DISMISSED'], [41, 'DISMISSED'], [42, 'DISMISSED']]);
  });

  it('touchActionStillAppliesWhenActiveFull', async () => {
    (d.memoryRepo.listActiveForDedup as ReturnType<typeof vi.fn>).mockImplementation(async (_u: number, scope: string) =>
      scope === 'USER' ? [{ id: 12, scope: 'USER', projectKey: '', content: '输出报告用中文' }] : []);
    (d.memoryRepo.countActive as ReturnType<typeof vi.fn>).mockResolvedValue(200);
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'user', action: 'touch', existingId: 12 }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    expect(d.memoryRepo.touch).toHaveBeenCalledWith(12);
    expect(d.memoryRepo.updateStatus).not.toHaveBeenCalled();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });

  it('degradesProjectItemToUserScopeWhenNoValidProjectKey', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'project', content: '该仓库测试用 Vitest' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession({ ...BASE_INPUT, projectKey: null, workspace: null }));
    expect((d.memoryRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0].scope).toBe('USER');

    (d.memoryRepo.insert as ReturnType<typeof vi.fn>).mockClear();
    await settle(svc.extractForSession({ ...BASE_INPUT, projectKey: 'weixin-bot', workspace: null }));
    expect((d.memoryRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0].scope).toBe('USER');
  });

  it('storesProjectScopeWithValidProjectKey', async () => {
    d.llm.chat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify([{ type: 'project', content: '该仓库测试用 Vitest' }]) } }],
    });
    const svc = buildService(d);
    await settle(svc.extractForSession(BASE_INPUT));
    const inserted = (d.memoryRepo.insert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(inserted.scope).toBe('PROJECT');
    expect(inserted.projectKey).toBe('mao');
  });

  it('serializesConcurrentExtractionsForSameSession', async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    d.llm.chat.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return { choices: [{ message: { content: JSON.stringify([{ type: 'user', content: `事实${calls}` }]) } }] };
    });
    const svc = buildService(d);
    const first = svc.extractForSession(BASE_INPUT);
    const second = svc.extractForSession(BASE_INPUT);
    let secondStarted = false;
    void second.then(() => { secondStarted = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(1);
    releaseFirst!();
    await settle(Promise.all([first, second]));
    expect(calls).toBe(2);
    expect(secondStarted).toBe(true);
  });

  it('swallowsLlmFailuresWithoutThrowing', async () => {
    d.llm.chat.mockRejectedValue(new Error('boom'));
    const svc = buildService(d);
    await expect(svc.extractForSession(BASE_INPUT)).resolves.toBeUndefined();
    expect(d.memoryRepo.insert).not.toHaveBeenCalled();
  });
});

describe('extractStoredText', () => {
  it('readsPlainTextAndMultimodalJsonArrays', () => {
    expect(extractStoredText('普通文本')).toBe('普通文本');
    expect(extractStoredText(JSON.stringify([
      { type: 'text', text: '第一段' },
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      { type: 'text', text: '第二段' },
    ]))).toBe('第一段\n第二段');
    expect(extractStoredText(null)).toBe('');
    expect(extractStoredText('   ')).toBe('');
  });
});

describe('toCandidate', () => {
  it('validatesTypeAndLength', () => {
    expect(toCandidate({ type: 'user', content: '  输出  中文 ' })).toEqual({ scope: 'USER', content: '输出 中文', action: 'insert', existingId: null });
    expect(toCandidate({ type: 'project', content: '测试用 Vitest' })).toEqual({ scope: 'PROJECT', content: '测试用 Vitest', action: 'insert', existingId: null });
    expect(toCandidate({ type: 'other', content: 'x' })).toBeNull();
    expect(toCandidate({ type: 'user', content: '' })).toBeNull();
    expect(toCandidate({ type: 'user', content: '长'.repeat(121) })).toBeNull();
    expect(toCandidate({ type: 'USER', content: '大写类型' })).toEqual({ scope: 'USER', content: '大写类型', action: 'insert', existingId: null });
  });

  it('parsesTouchUpdateActions', () => {
    expect(toCandidate({ type: 'user', action: 'TOUCH', existingId: 12 })).toEqual({ scope: 'USER', content: '', action: 'touch', existingId: 12 });
    expect(toCandidate({ type: 'user', action: 'update', existingId: '12', content: '新表述' }))
      .toEqual({ scope: 'USER', content: '新表述', action: 'update', existingId: 12 });
    // 缺合法 existingId 或 update 缺内容：整条丢弃
    expect(toCandidate({ type: 'user', action: 'touch' })).toBeNull();
    expect(toCandidate({ type: 'user', action: 'touch', existingId: 0 })).toBeNull();
    expect(toCandidate({ type: 'user', action: 'update', existingId: 12, content: '  ' })).toBeNull();
    // action 非法值按 insert 处理（向后兼容旧协议）
    expect(toCandidate({ type: 'user', action: 'INSERT', content: '事实' })).toEqual({ scope: 'USER', content: '事实', action: 'insert', existingId: null });
  });
});
