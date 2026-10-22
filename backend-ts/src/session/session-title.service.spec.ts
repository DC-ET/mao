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
    hasOwnEarlierUserMessage: vi.fn(async () => false),
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

  it('strips injected image url lines from the title input', async () => {
    const ctx = makeService();
    // 注入行只服务于模型下载文件本体，不能进标题输入（技术方案 2026-10-22 §5.4）
    await ctx.service.generateAndApply(11, 21, [{
      type: 'text',
      text: '这个图片能帮我转成CAD格式的文件？\n\n[图片 1] https://mao.etarch.cn/uploads/a.png',
    }, { type: 'image_url', imageUrl: { url: 'https://mao.etarch.cn/uploads/a.png' } }]);
    expect(ctx.llm.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '这个图片能帮我转成CAD格式的文件？' },
      ],
    }), expect.anything(), expect.anything());
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      11, 'NORMAL', '未命名会话', '排查登录接口超时', expect.any(String),
    );
  });

  it('skips non-first messages and unsupported session types', async () => {
    const earlier = makeService({ messageRepo: { hasOwnEarlierUserMessage: vi.fn(async () => true) } });
    await earlier.service.generateAndApply(11, 21, 'hello');
    expect(earlier.llm.chat).not.toHaveBeenCalled();

    const subagent = makeService({ sessionRepo: { findById: vi.fn(async () => ({ id: 11, userId: 7, title: '子代理', sessionType: 'SUBAGENT' })) } });
    await subagent.service.generateAndApply(11, 21, 'hello');
    expect(subagent.messageRepo.hasOwnEarlierUserMessage).not.toHaveBeenCalled();
    expect(subagent.llm.chat).not.toHaveBeenCalled();
  });

  it('titles a forked side task whose earlier user messages are copies', async () => {
    // 分叉边路任务的历史用户消息 source_session_id 均非空，判定为「没有更早的自己的用户消息」，
    // 否则标题永远停在占位符「任务」。
    const ctx = makeService({
      sessionRepo: { findById: vi.fn(async () => ({
        id: 12, userId: 7, title: '任务', sessionType: 'SIDE_TASK', parentSessionId: 11, modelId: 3,
      })) },
      messageRepo: { hasOwnEarlierUserMessage: vi.fn(async () => false) },
    });
    await ctx.service.generateAndApply(12, 22, '继续深挖压缩边界');
    expect(ctx.messageRepo.hasOwnEarlierUserMessage).toHaveBeenCalledWith(12, 22);
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).toHaveBeenCalledWith(
      12, 'SIDE_TASK', '任务', '排查登录接口超时', expect.any(String),
    );
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

  it('generates an external channel title as text only, without persisting or pushing', async () => {
    const ctx = makeService();
    const title = await ctx.service.generateExternalTitle(11, '帮我把这份需求文档整理成任务拆解清单');
    expect(title).toBe('排查登录接口超时');
    expect(ctx.llm.chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        expect.objectContaining({ role: 'system' }),
        { role: 'user', content: '帮我把这份需求文档整理成任务拆解清单' },
      ],
      tools: [], stream: false, temperature: 0.2,
    }), expect.objectContaining({ id: 9 }), expect.anything());
    // 落库与 WS 推送由调用方（飞书 finalizeNewSessionTitle）按待命名标志决定。
    expect(ctx.sessionRepo.updateTitleIfPlaceholder).not.toHaveBeenCalled();
    expect(ctx.registry.send).not.toHaveBeenCalled();
  });

  it('returns null for an external title when the session is gone or the text preprocesses to empty', async () => {
    const missing = makeService({ sessionRepo: { findById: vi.fn(async () => null) } });
    expect(await missing.service.generateExternalTitle(11, 'hello')).toBeNull();
    expect(missing.llm.chat).not.toHaveBeenCalled();

    const blank = makeService();
    expect(await blank.service.generateExternalTitle(11, '${a}$ ${b}$')).toBeNull();
    expect(blank.llm.chat).not.toHaveBeenCalled();
  });

  it('falls back to the local heuristic for external titles when the model is unavailable or fails', async () => {
    const noModel = makeService();
    noModel.models.selectDefault.mockResolvedValue(null);
    expect(await noModel.service.generateExternalTitle(11, '  整理需求文档  ')).toBe('整理需求文档');
    expect(noModel.llm.chat).not.toHaveBeenCalled();

    const failed = makeService();
    failed.llm.chat.mockRejectedValue(new Error('timeout'));
    expect(await failed.service.generateExternalTitle(11, '整理需求文档')).toBe('整理需求文档');
  });
});
