import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { PromptEngine } from './prompt-engine.js';
import { SessionHistoryLoader } from './session-history-loader.js';
import { PersistedChatMessage } from './persisted-chat-message.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import {
  applyNoProgressNotices,
  roundSignature,
  scanNoProgressNotices,
  type NoProgressCall,
} from './no-progress-notice.js';
import { NoProgressGuard } from './no-progress-guard.js';
import type { ChatMessage } from '../llm/chat-request.js';
import type { Message } from '../deps.js';

const ARGS = '{"path":"backend-ts/src/feishu","pattern":"群名"}';
const RESULT = '{"total_matches":0,"matches":[]}';

function roundMessages(index: number): ChatMessage[] {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id: `call-${index}`, function: { name: 'grep_search', arguments: ARGS } }] },
    { role: 'tool', toolCallId: `call-${index}`, content: RESULT },
  ];
}

function identicalRounds(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 1; i <= count; i++) messages.push(...roundMessages(i));
  return messages;
}

function engine(): PromptEngine {
  const workspace = useTmpDir('np-render-');
  const runtime = RuntimeDataResolver.forTest(`${workspace}/runtime`, `${workspace}/home`);
  return new PromptEngine(
    { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
    { getWorkspaceRoot: () => workspace } as never,
    runtime,
    { getByUserIdAndName: async () => null } as never,
    { getUserSkillDocuments: () => [] } as never,
  );
}

function contextWith(messages: ChatMessage[]): AgentExecutionContext {
  const context = new AgentExecutionContext();
  context.userId = 7;
  context.executionMode = 'CLOUD';
  context.messages = messages.map((message) => ({ ...message }));
  return context;
}

function serialize(messages: ChatMessage[] | undefined): string {
  return JSON.stringify(messages ?? []);
}

describe('no-progress prompt rendering', () => {
  it('renders the notice after the anchor tool message without touching context.messages', async () => {
    const messages = identicalRounds(5);
    const context = contextWith(messages);
    context.noProgressNotices = scanNoProgressNotices(context.messages).notices;

    const request = await engine().buildRequest(context);
    const composed = request.messages ?? [];
    const anchorIndex = composed.findIndex((message) => message.toolCallId === 'call-5');
    expect(anchorIndex).toBeGreaterThan(0);
    expect(composed[anchorIndex + 1]).toEqual(expect.objectContaining({ role: 'user' }));
    expect(composed[anchorIndex + 1].content).toContain('<system-notice>');
    expect(composed[anchorIndex + 1].content).toContain('最近 5 轮的工具调用与结果完全一致');

    // 提醒不落上下文：context.messages 仍是 10 条，且不含提醒文本
    expect(context.messages).toHaveLength(10);
    expect(JSON.stringify(context.messages)).not.toContain('检测到重复调用');
  });

  it('renders byte-identically for the runtime guard path and the history replay path', async () => {
    const messages = identicalRounds(5);
    const call: NoProgressCall = { toolName: 'grep_search', argumentsJson: ARGS, resultContent: RESULT };

    // 运行时路径：guard 逐轮推进，第 5 轮 nudge 进入 context.noProgressNotices
    const runtimeContext = contextWith(messages);
    const guard = new NoProgressGuard();
    const runtimeNotices = [];
    for (let i = 1; i <= 5; i++) {
      guard.observeCall(call);
      guard.endRound(`call-${i}`);
      const action = guard.takeAction();
      if (action?.kind === 'nudge') {
        runtimeNotices.push({ afterToolCallId: action.afterToolCallId, text: action.text });
      }
    }
    runtimeContext.noProgressNotices = runtimeNotices;

    // 重放路径：从持久化消息重新扫描
    const replayContext = contextWith(messages);
    const scanned = scanNoProgressNotices(replayContext.messages);
    replayContext.noProgressNotices = scanned.notices;

    const promptEngine = engine();
    const runtime = serialize((await promptEngine.buildRequest(runtimeContext)).messages);
    const replay = serialize((await promptEngine.buildRequest(replayContext)).messages);
    expect(replay).toBe(runtime);
    expect(runtimeContext.messages).toEqual(replayContext.messages);
  });

  it('replays the same request after a simulated service restart', async () => {
    const messages = identicalRounds(5);
    const promptEngine = engine();
    const before = contextWith(messages);
    before.noProgressNotices = scanNoProgressNotices(before.messages).notices;
    const beforeRequest = serialize((await promptEngine.buildRequest(before)).messages);

    // 丢弃上下文后重新装载（applyHistory 的等价动作）
    const after = contextWith(messages);
    const rescanned = scanNoProgressNotices(after.messages);
    after.noProgressNotices = rescanned.notices;
    after.noProgressTail = rescanned.tail;
    const afterRequest = serialize((await promptEngine.buildRequest(after)).messages);

    expect(afterRequest).toBe(beforeRequest);
    expect(after.noProgressTail).toEqual(expect.objectContaining({ streak: 5 }));
  });

  it('keeps the notice between the tool group and synthetic media messages', async () => {
    const messages: ChatMessage[] = [...roundMessages(1), ...roundMessages(2)];
    const context = contextWith(messages);
    context.modelConfig = { supportsVision: true };
    context.toolAttachments.set('call-1', { mime: 'image/png', path: '/tmp/a.png', dataUri: 'data:image/png;base64,AAA' });
    context.noProgressNotices = [{ afterToolCallId: 'call-1', text: 'hi' }];

    const composed = (await engine().buildRequest(context)).messages ?? [];
    const anchorIndex = composed.findIndex((message) => message.toolCallId === 'call-1');
    expect(composed[anchorIndex + 1].content).toBe('<system-notice>\nhi\n</system-notice>');
    expect(Array.isArray(composed[anchorIndex + 2].content)).toBe(true);
  });
});

describe('SessionHistoryLoader no-progress wiring', () => {
  function loader(): SessionHistoryLoader {
    const sessionService = {
      getLastUserMessage: vi.fn(async () => null),
      getPreviousUserStamp: vi.fn(async () => null),
    };
    const contextManager = {
      prependSessionSummary: (
        _summary: string | null | undefined,
        incremental: ChatMessage[],
      ) => incremental,
    };
    const archive = { buildArchiveHint: () => null };
    return new SessionHistoryLoader(
      sessionService as never,
      contextManager as never,
      archive as never,
    );
  }

  function entity(index: number): Message {
    return {
      id: index * 2,
      role: 'ASSISTANT',
      content: '',
      toolCalls: JSON.stringify([{ id: `call-${index}`, type: 'function', function: { name: 'grep_search', arguments: ARGS } }]),
    } as Message;
  }

  it('rebuilds notices and tail from persisted history', async () => {
    const messagePairs: Message[] = [];
    for (let i = 1; i <= 5; i++) {
      messagePairs.push(entity(i));
      messagePairs.push({
        id: i * 2 + 1,
        role: 'TOOL',
        content: RESULT,
        toolCallId: `call-${i}`,
        // 每轮同一张图片：附件参与摘要，只有全部一致才构成「无进展」
        metadata: JSON.stringify({ attachments: [{ mime: 'image/png', path: '/tmp/a.png', data_uri: 'data:image/png;base64,AAA' }] }),
      } as Message);
    }
    const persisted = messagePairs.map((message) => new PersistedChatMessage(
      message.id!,
      message.content ?? '',
      {
        role: message.role?.toLowerCase(),
        content: message.content ?? '',
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        ...(message.toolCalls ? { toolCalls: JSON.parse(message.toolCalls) } : {}),
      },
    ));
    const context = new AgentExecutionContext();
    context.sessionId = 11;
    context.executionMode = 'CLOUD';

    await loader().applyHistory(context, null, {
      snapshotMessageIds: messagePairs.map((message) => message.id!),
      normalizedEntities: messagePairs,
      persistedMessages: persisted,
    });

    expect(context.noProgressNotices).toHaveLength(1);
    expect(context.noProgressNotices[0].afterToolCallId).toBe('call-5');
    expect(context.noProgressTail).toEqual(expect.objectContaining({ streak: 5, nudgedAt: [5] }));
    expect(context.toolAttachments.get('call-5')?.dataUri).toBe('data:image/png;base64,AAA');
  });

  it('clears stale notices when the window no longer contains a loop', async () => {
    const context = new AgentExecutionContext();
    context.sessionId = 11;
    context.noProgressNotices = [{ afterToolCallId: 'stale', text: 'stale' }];
    context.noProgressTail = { streak: 9, lastRoundKey: 'k', nudgedAt: [5] };

    await loader().applyHistory(context, null, {
      snapshotMessageIds: [1],
      normalizedEntities: [{ id: 1, role: 'USER', content: 'hi' } as Message],
      persistedMessages: [new PersistedChatMessage(1, 'hi', { role: 'user', content: 'hi' })],
    });

    expect(context.noProgressNotices).toEqual([]);
    expect(context.noProgressTail).toBeNull();
  });
});

describe('no-progress round signature sharing', () => {
  it('uses the same signature for the guard and the scanner', () => {
    const calls: NoProgressCall[] = [
      { toolName: 'grep_search', argumentsJson: '{"b":2,"a":1}', resultContent: RESULT },
      { toolName: 'shell', argumentsJson: '{"command":"ls"}', resultContent: '{"exit_code":0,"output":"a\\n","completed":true}' },
    ];
    const scanned = scanNoProgressNotices(identicalRounds(5));
    expect(scanned.tail!.lastRoundKey).toBe(roundSignature([
      { toolName: 'grep_search', argumentsJson: ARGS, resultContent: RESULT },
    ]));
    expect(roundSignature(calls)).not.toBe(roundSignature([calls[1], calls[0]]));
  });
});

describe('no-progress notice application', () => {
  it('never mutates the input message objects', () => {
    const messages = identicalRounds(5);
    const snapshot = JSON.stringify(messages);
    applyNoProgressNotices(messages, [{ afterToolCallId: 'call-5', text: 'x' }]);
    expect(JSON.stringify(messages)).toBe(snapshot);
  });
});
