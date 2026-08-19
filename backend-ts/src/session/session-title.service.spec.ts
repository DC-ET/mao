import { describe, expect, it, vi } from 'vitest';
import { SessionTitleService, cleanModelTitle } from './session-title.service.js';

function makeService(overrides: Record<string, unknown> = {}) {
  const sessionRepo = {
    findById: vi.fn(async () => ({
      id: 11, userId: 7, title: '未命名会话', sessionType: 'NORMAL', modelId: 3,
    })),
    updateTitleIfPlaceholder: vi.fn(async () => 1),
    ...overrides.sessionRepo as object,
  };
  const messageRepo = {
    hasEarlierUserMessage: vi.fn(async () => false),
    ...overrides.messageRepo as object,
  };
  const userCommands = {
    listAvailableForUser: vi.fn(async () => [{ name: 'fix', content: '修复登录错误' }]),
  };
  const llm = {
    chat: vi.fn(async () => ({ choices: [{ message: { content: '“排查登录接口超时。”\n这是解释' } }] })),
  };
  const models = {
    selectById: vi.fn(async () => ({ id: 3, name: 'model', modelId: 'model' })),
    selectDefault: vi.fn(async () => ({ id: 9, name: 'default', modelId: 'default' })),
  };
  const settings = {
    getValue: vi.fn(async () => ''),
    ...overrides.settings as object,
  };
  const registry = { send: vi.fn() };
  const tasks: Array<() => void | Promise<void>> = [];
  const executor = vi.fn((fn: () => void | Promise<void>) => tasks.push(fn));
  const service = new SessionTitleService(
    sessionRepo as never,
    messageRepo as never,
    userCommands as never,
    llm as never,
    models as never,
    settings as never,
    registry as never,
    executor,
  );
  return { service, sessionRepo, messageRepo, userCommands, llm, models, settings, registry, executor, tasks };
}

describe('cleanModelTitle', () => {
  it('removes wrappers, prefixes, markdown, explanations and terminal punctuation', () => {
    expect(cleanModelTitle('  ## 标题：`排查登录超时。`\n解释内容')).toBe('排查登录超时')
    expect(cleanModelTitle('- Title: "Fix login timeout!"')).toBe('Fix login timeout')
    expect(cleanModelTitle('“标题：排查登录超时。”')).toBe('排查登录超时')
    expect(cleanModelTitle('"Title: Fix login timeout!"')).toBe('Fix login timeout')
    expect(cleanModelTitle('   ')).toBeNull()
  });

  it('does not truncate model output', () => {
    const long = '这是一个明显超过十五个字符但模型仍然返回的会话标题';
    expect(cleanModelTitle(long)).toBe(long);
  });
});

describe('SessionTitleService', () => {
  it('schedules without awaiting and applies a cleaned model title', async () => {
    const ctx = makeService();
    ctx.service.scheduleForFirstUserMessage(11, 21, '请排查登录超时');
    expect(ctx.executor).toHaveBeenCalledOnce();
    expect(ctx.llm.chat).not.toHaveBeenCalled();
    await ctx.tasks[0]();
    expect(ctx.llm.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '请排查登录超时' },
      ],
      tools: [],
      stream: false,
      temperature: 0.2,
      reasoning: { effort: 'none' },
      thinking: { type: 'disabled' },
      enableThinking: false,
    }), expect.objectContaining({ id: 9 }), expect.anything());
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      11, 'NORMAL', '未命名会话', '排查登录接口超时', expect.any(String),
    );
    expect(ctx.registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      type: 'session_title_updated',
      sessionId: 11,
      data: { title: '排查登录接口超时', parentSessionId: null, sessionType: 'NORMAL' },
    }));
  });

  it('uses the configured title model when session.titleModelId is set', async () => {
    const ctx = makeService({ settings: { getValue: vi.fn(async () => '3') } });
    await ctx.service.generateAndApply(11, 21, '请排查登录超时');
    expect(ctx.settings.getValue).toHaveBeenCalledWith('session.titleModelId');
    expect(ctx.models.selectById).toHaveBeenCalledWith(3);
    expect(ctx.models.selectDefault).not.toHaveBeenCalled();
    expect(ctx.llm.chat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 3 }), expect.anything());
  });

  it('falls back to the default model when the configured title model is missing', async () => {
    const ctx = makeService({ settings: { getValue: vi.fn(async () => '999') } });
    ctx.models.selectById.mockResolvedValue(null);
    await ctx.service.generateAndApply(11, 21, '请排查登录超时');
    expect(ctx.models.selectById).toHaveBeenCalledWith(999);
    expect(ctx.models.selectDefault).toHaveBeenCalled();
    expect(ctx.llm.chat).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 9 }), expect.anything());
  });

  it('preprocesses commands, skills and file references before invoking the model', async () => {
    const ctx = makeService();
    await ctx.service.generateAndApply(11, 21, '${review}$ #{fix}# @{secret.ts}@');
    expect(ctx.userCommands.listAvailableForUser).toHaveBeenCalledWith(7);
    expect(ctx.llm.chat.mock.calls[0][0].messages[1]).toEqual({ role: 'user', content: '修复登录错误' });
  });

  it('continues with raw command markers when command lookup fails', async () => {
    const ctx = makeService();
    ctx.userCommands.listAvailableForUser.mockRejectedValue(new Error('database unavailable'));
    ctx.models.selectDefault.mockResolvedValue(null);
    await ctx.service.generateAndApply(11, 21, '${review}$ #{fix}# @{secret.ts}@');
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      11, 'NORMAL', '未命名会话', '#{fix}#', expect.any(String),
    );
  });

  it('uses the default model when no title model is configured', async () => {
    const ctx = makeService();
    await ctx.service.generateAndApply(11, 21, 'hello');
    expect(ctx.settings.getValue).toHaveBeenCalledWith('session.titleModelId');
    expect(ctx.models.selectDefault).toHaveBeenCalled();
    expect(ctx.models.selectById).not.toHaveBeenCalled();
  });

  it('falls back to the preprocessed prefix when model resolution or output fails', async () => {
    const ctx = makeService();
    ctx.models.selectDefault.mockResolvedValue(null);
    await ctx.service.generateAndApply(11, 21, '  fallback title  ');
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      11, 'NORMAL', '未命名会话', 'fallback title', expect.any(String),
    );
    expect(ctx.llm.chat).not.toHaveBeenCalled();
  });

  it('uses a fixed title for an image-only first message without calling the model', async () => {
    const ctx = makeService();
    await ctx.service.generateAndApply(11, 21, [{ type: 'text', text: '' }, { type: 'image_url', imageUrl: { url: 'x' } }]);
    expect(ctx.llm.chat).not.toHaveBeenCalled();
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      11, 'NORMAL', '未命名会话', '图片消息', expect.any(String),
    );
  });

  it('skips non-first messages and unsupported session types', async () => {
    const earlier = makeService({ messageRepo: { hasEarlierUserMessage: vi.fn(async () => true) } });
    await earlier.service.generateAndApply(11, 21, 'hello');
    expect(earlier.llm.chat).not.toHaveBeenCalled();

    const subagent = makeService({ sessionRepo: { findById: vi.fn(async () => ({ id: 11, userId: 7, title: '子代理', sessionType: 'SUBAGENT' })) } });
    await subagent.service.generateAndApply(11, 21, 'hello');
    expect(subagent.messageRepo.hasEarlierUserMessage).not.toHaveBeenCalled();
    expect(subagent.llm.chat).not.toHaveBeenCalled();
  });

  it('does not publish when a manual rename wins the conditional update', async () => {
    const ctx = makeService({ sessionRepo: { updateTitleIfPlaceholder: vi.fn(async () => 0) } });
    await ctx.service.generateAndApply(11, 21, 'hello');
    expect(ctx.registry.send).not.toHaveBeenCalled();
  });

  it('uses the side task placeholder and sends parent metadata', async () => {
    const ctx = makeService({ sessionRepo: { findById: vi.fn(async () => ({
      id: 12, userId: 7, title: '任务', sessionType: 'SIDE_TASK', parentSessionId: 11, modelId: 3,
    })) } });
    await ctx.service.generateAndApply(12, 22, 'hello');
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      12, 'SIDE_TASK', '任务', '排查登录接口超时', expect.any(String),
    );
    expect(ctx.registry.send).toHaveBeenCalledWith(7, expect.objectContaining({
      data: expect.objectContaining({ parentSessionId: 11, sessionType: 'SIDE_TASK' }),
    }));
  });
});
