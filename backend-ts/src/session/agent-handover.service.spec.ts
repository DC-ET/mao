import { describe, expect, it, vi } from 'vitest';
import { AgentHandoverService } from './agent-handover.service.js';
import type { Message, Session } from './types.js';
import type { LlmModel } from '../domain/types.js';

const model: LlmModel = { id: 3, name: 'gpt', status: 1, isDefault: 1 };

function session(overrides: Partial<Session> = {}): Session {
  return { id: 10, userId: 7, agentId: 5, ...overrides } as Session;
}

function row(id: number, role: string, content: string | null): Message {
  // 生产库 role 为大写枚举（V001：USER / ASSISTANT / SYSTEM / TOOL）
  return { id, sessionId: 10, role: role.toUpperCase(), content } as Message;
}

function makeService(
  messages: Message[],
  options: {
    chat?: (messages: Array<{ role: string; content: unknown }>) => Promise<unknown> | never;
    configuredModel?: LlmModel | null;
    defaultModel?: LlmModel | null;
    settingValue?: string | null;
  } = {},
) {
  const messageRepo = { listBySession: vi.fn(async () => messages) };
  const llmAdapter = {
    chat: options.chat
      ? vi.fn(options.chat as never)
      : vi.fn(async () => ({ choices: [{ message: { content: '  背景与结论说明  ' } }] })),
  };
  const modelLookup = {
    selectById: vi.fn(async () => options.configuredModel ?? null),
    selectDefault: vi.fn(async () => options.defaultModel !== undefined ? options.defaultModel : model),
  };
  const settingLookup = { getValue: vi.fn(async () => options.settingValue ?? null) };
  const service = new AgentHandoverService(
    messageRepo as never,
    llmAdapter as never,
    modelLookup,
    settingLookup,
  );
  return { service, messageRepo, llmAdapter, modelLookup, settingLookup };
}

describe('AgentHandoverService', () => {
  it('returnsTrimmedNoteOnSuccess', async () => {
    const { service, llmAdapter } = makeService([
      row(1, 'user', '帮我分析日志'),
      row(2, 'assistant', '已完成初步分析'),
    ]);
    const note = await service.generateHandoverNote(session());
    expect(note).toBe('背景与结论说明');
    expect(llmAdapter.chat).toHaveBeenCalledTimes(1);
    const call = vi.mocked(llmAdapter.chat).mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    // 转录按时间正序进入提示词：用户在前、助手在后
    expect(call.messages[1]!.content).toContain('用户：帮我分析日志');
    expect(call.messages[1]!.content).toContain('助手：已完成初步分析');
  });

  it('filtersCompactionAndNoticeRowsAndEmptyLines', async () => {
    const { service, llmAdapter } = makeService([
      row(1, 'user', '<system-notice>\n压缩摘要占位\n</system-notice>'),
      row(2, 'user', '## 会话压缩摘要\n旧上下文'),
      row(3, 'user', ''),
      row(4, 'tool', '工具结果行'),
      row(5, 'user', '真实提问'),
      row(6, 'assistant', '真实回答'),
    ]);
    await service.generateHandoverNote(session());
    const call = vi.mocked(llmAdapter.chat).mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const transcript = call.messages[1]!.content;
    expect(transcript).toContain('真实提问');
    expect(transcript).toContain('真实回答');
    expect(transcript).not.toContain('system-notice');
    expect(transcript).not.toContain('会话压缩摘要');
    expect(transcript).not.toContain('工具结果行');
  });

  it('returnsNullWithoutLlmCallWhenTranscriptEmpty', async () => {
    const { service, llmAdapter } = makeService([row(1, 'user', '')]);
    const note = await service.generateHandoverNote(session());
    expect(note).toBeNull();
    expect(llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('returnsNullWhenNoModelAvailable', async () => {
    const { service, llmAdapter } = makeService(
      [row(1, 'user', '帮我分析日志')],
      { defaultModel: null },
    );
    const note = await service.generateHandoverNote(session());
    expect(note).toBeNull();
    expect(llmAdapter.chat).not.toHaveBeenCalled();
  });

  it('returnsNullWhenLlmFails', async () => {
    const { service } = makeService(
      [row(1, 'user', '帮我分析日志')],
      { chat: () => { throw new Error('boom'); }, defaultModel: model },
    );
    const note = await service.generateHandoverNote(session());
    expect(note).toBeNull();
  });

  it('prefersConfiguredTitleModelThenDefault', async () => {
    const configured: LlmModel = { id: 9, name: 'cheap', status: 1 };
    const withConfig = makeService([row(1, 'user', 'q')], {
      settingValue: '9', configuredModel: configured, defaultModel: model,
    });
    await withConfig.service.generateHandoverNote(session());
    expect(withConfig.modelLookup.selectById).toHaveBeenCalledWith(9);
    expect(withConfig.modelLookup.selectDefault).not.toHaveBeenCalled();

    const withoutConfig = makeService([row(1, 'user', 'q')], { defaultModel: model });
    await withoutConfig.service.generateHandoverNote(session());
    expect(withoutConfig.modelLookup.selectDefault).toHaveBeenCalledTimes(1);
  });

  it('acceptsLowercaseRolesToo', async () => {
    // 实现对小写 role 同样放行（历史数据 / 测试夹具可能小写），防止口径单一化回归
    const lowercase: Message[] = [
      { id: 1, sessionId: 10, role: 'user', content: '小写用户消息' },
      { id: 2, sessionId: 10, role: 'assistant', content: '小写助手回复' },
    ] as Message[];
    const { service, llmAdapter } = makeService(lowercase);
    await service.generateHandoverNote(session());
    expect(llmAdapter.chat).toHaveBeenCalledTimes(1);
    const call = vi.mocked(llmAdapter.chat).mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    expect(call.messages[1]!.content).toContain('小写用户消息');
    expect(call.messages[1]!.content).toContain('小写助手回复');
  });

  it('capsTranscriptAtFortyLatestMessages', async () => {
    const messages: Message[] = [];
    for (let i = 1; i <= 60; i++) {
      messages.push(row(i, i % 2 === 1 ? 'user' : 'assistant', `msg-${i}`));
    }
    const { service, llmAdapter } = makeService(messages);
    await service.generateHandoverNote(session());
    const call = vi.mocked(llmAdapter.chat).mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> };
    const transcript = call.messages[1]!.content;
    expect(transcript).toContain('msg-60');
    expect(transcript).toContain('msg-21');
    expect(transcript).not.toContain('msg-19');
    expect(transcript).not.toContain('msg-1');
  });
});
