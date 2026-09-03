import { describe, expect, it, vi } from 'vitest';
import { TokenEstimator } from './token-estimator.js';
import { MessageHistoryNormalizer } from './message-history-normalizer.js';
import { LocalAgentsMdRegistry } from './local-agents-md-registry.js';
import { BackgroundTaskManager } from './background-task-manager.js';
import { CompositeAgentEventListener } from './composite-agent-event-listener.js';
import { EnvironmentInfoProvider } from './environment-info-provider.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AgentEventListener } from './agent-event-listener.js';
import { UPDATE_WITH_BOUNDARY_CAS } from './session-compaction.mapper.js';

describe('TokenEstimator', () => {
  const estimator = new TokenEstimator();

  it('contentToStringHandlesPlainTextContentPartsAndMaps', () => {
    const part = { type: 'text', text: 'hello' };
    expect(TokenEstimator.contentToString('plain')).toBe('plain');
    expect(TokenEstimator.contentToString([part, { type: 'text', text: ' map' }])).toBe('hello map');
    expect(TokenEstimator.contentToString(null)).toBe('');
    expect(TokenEstimator.contentToString(123)).toBe('123');
  });

  it('countTokensUsesUtf8BytesDiv4', () => {
    expect(estimator.countTokens(null)).toBe(0);
    expect(estimator.countTokens('')).toBe(0);
    expect(estimator.countTokens('abcd')).toBe(1);
    expect(estimator.countTokens('abcde')).toBe(2);
    expect(estimator.countTokens('中')).toBe(1);
    expect(estimator.countTokens('中文')).toBe(2);
  });

  it('estimatesMessagesToolCallsDefinitionsAndWholeRequests', () => {
    const toolCall = { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } };
    const assistant = { role: 'assistant', content: "I'll read it", toolCalls: [toolCall] };
    const tool = { role: 'tool', toolCallId: 'call-1', content: 'content' };
    const definition = {
      type: 'function',
      function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', required: ['path'] } },
    };
    const request = { messages: [assistant, tool], tools: [definition] };
    expect(estimator.countTokens('hello world')).toBeGreaterThan(0);
    expect(estimator.estimateMessage(assistant)).toBeGreaterThan(0);
    expect(estimator.estimateMessages([assistant, tool])).toBeGreaterThan(estimator.estimateMessage(assistant));
    expect(estimator.estimateToolDefinitions([definition])).toBeGreaterThan(0);
    expect(estimator.estimateRequestTokens(request)).toBeGreaterThan(estimator.estimateMessages([assistant, tool]));
  });
});

describe('MessageHistoryNormalizer', () => {
  it('normalizeChatMessagesMovesToolsAfterAssistantCallsAndDropsOrphans', () => {
    const user = { role: 'user', content: 'hi' };
    const tool = { role: 'tool', toolCallId: 'call-1', content: 'ok' };
    const orphan = { role: 'tool', toolCallId: 'missing', content: 'orphan' };
    const assistant = { role: 'assistant', toolCalls: [{ id: 'call-1' }] };
    const normalized = MessageHistoryNormalizer.normalizeChatMessages([user, tool, orphan, assistant]);
    expect(normalized).toEqual([user, assistant, tool]);
  });

  it('ensureContentPresentFillsNullContentWithEmptyString', () => {
    const assistant = { role: 'assistant', content: undefined as unknown as string, toolCalls: [{ id: 'call-1' }] };
    MessageHistoryNormalizer.ensureContentPresent([assistant]);
    expect(assistant.content).toBe('');
  });

  it('normalizeChatMessagesReturnsOriginalWhenNoWorkNeeded', () => {
    const one = [{ role: 'user', content: 'hi' }];
    expect(MessageHistoryNormalizer.normalizeChatMessages(null)).toBeNull();
    expect(MessageHistoryNormalizer.normalizeChatMessages(one)).toBe(one);
  });

  it('normalizeEntitiesMovesToolsAfterAssistantCalls', () => {
    const user = { role: 'USER', toolCallId: null as string | null, toolCalls: null as string | null };
    const tool = { role: 'TOOL', toolCallId: 'call-1', toolCalls: null };
    const assistant = { role: 'ASSISTANT', toolCallId: null, toolCalls: JSON.stringify([{ id: 'call-1' }]) };
    const orphan = { role: 'TOOL', toolCallId: 'missing', toolCalls: null };
    const normalized = MessageHistoryNormalizer.normalizeEntities(
      [user, tool, orphan, assistant] as never,
      (json) => JSON.parse(json),
    );
    expect(normalized).toEqual([user, assistant, tool]);
  });

  it('normalizeEntitiesDropsToolsWhenToolCallsJsonIsInvalid', () => {
    const assistant = { role: 'ASSISTANT', toolCallId: null, toolCalls: 'not-json' };
    const tool = { role: 'TOOL', toolCallId: 'call-1', toolCalls: null };
    const normalized = MessageHistoryNormalizer.normalizeEntities(
      [tool, assistant] as never,
      () => [],
    );
    expect(normalized).toEqual([assistant]);
  });
});

describe('LocalAgentsMdRegistry', () => {
  const registry = new LocalAgentsMdRegistry();

  it('reportAndGetRoundTrips', () => {
    const content = '# 项目规则\n\n- 使用 TypeScript\n';
    registry.report(11, content);
    expect(registry.get(11)).toBe(content);
  });

  it('getReturnsNullForUnknownSession', () => {
    expect(registry.get(999)).toBeNull();
    expect(registry.get(null)).toBeNull();
  });

  it('reportNullClearsPreviousReport', () => {
    registry.report(5, '# Some rules');
    registry.report(5, null);
    expect(registry.get(5)).toBeNull();
  });

  it('reportBlankContentClearsPreviousReport', () => {
    registry.report(5, '# Some rules');
    expect(registry.get(5)).toBeTruthy();
    registry.report(5, '   ');
    expect(registry.get(5)).toBeNull();
  });

  it('clearRemovesReportedContent', () => {
    registry.report(5, '# Rules');
    registry.clear(5);
    expect(registry.get(5)).toBeNull();
  });

  it('reportOverwritesPreviousContent', () => {
    registry.report(5, '# Old rules');
    registry.report(5, '# New rules');
    expect(registry.get(5)).toBe('# New rules');
  });

  it('reportTruncatesLargeContent', () => {
    registry.report(5, 'a'.repeat(110 * 1024));
    expect(registry.get(5)).toHaveLength(100 * 1024);
  });

  it('reportIgnoresNullSessionId', () => {
    registry.report(null, '# Rules');
    expect(registry.get(null)).toBeNull();
  });

  it('clearIgnoresNullSessionId', () => {
    registry.clear(null);
  });
});

describe('BackgroundTaskManager', () => {
  it('consumesCompletedSuccessFailureAndTruncatedResults', async () => {
    const manager = new BackgroundTaskManager();
    const ok = manager.submit(11, () => 'done');
    const longTask = manager.submit(11, () => 'x'.repeat(20001));    const failed = manager.submit(11, () => { throw new Error('boom'); });
    await new Promise((r) => setTimeout(r, 50));
    const completed = await manager.consumeCompletedResults(11);
    expect(completed[ok]).toBe('done');
    expect(completed[longTask]).toMatch(/\.\.\. \[truncated\]$/);
    expect(completed[failed]).toContain('Error: boom');
    expect(await manager.consumeCompletedResults(11)).toEqual({});
  });

  it('consumeOnlyReturnsResultsForMatchingSession', async () => {
    const manager = new BackgroundTaskManager();
    const forA = manager.submit(1, () => 'from-a');
    const forB = manager.submit(2, () => 'from-b');
    await new Promise((r) => setTimeout(r, 50));
    const consumedByB = await manager.consumeCompletedResults(2);
    expect(Object.keys(consumedByB)).toEqual([forB]);
    expect(consumedByB[forB]).toBe('from-b');
    const consumedByA = await manager.consumeCompletedResults(1);
    expect(Object.keys(consumedByA)).toEqual([forA]);
    expect(consumedByA[forA]).toBe('from-a');
  });

  it('gcUnconsumedCompletedResultsFromOtherSessionsAfterAbandonedThreshold', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const manager = new BackgroundTaskManager();
      manager.submit(1, () => 'from-a');
      await Promise.resolve();
      await Promise.resolve();
      expect(await manager.consumeCompletedResults(2)).toEqual({});
      vi.setSystemTime(new Date('2026-01-01T00:31:00Z'));
      expect(await manager.consumeCompletedResults(2)).toEqual({});
      expect(await manager.consumeCompletedResults(1)).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumeRemovesAllCompletedEntriesWithoutSkippingUnderManyTasks', async () => {
    const manager = new BackgroundTaskManager();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(manager.submit(9, () => 'ok'));
    await new Promise((r) => setTimeout(r, 80));
    const first = await manager.consumeCompletedResults(9);
    expect(Object.keys(first).sort()).toEqual([...ids].sort());
    expect(await manager.consumeCompletedResults(9)).toEqual({});
  });

  it('awaitResultHandlesMissingTimeoutSuccessAndFailure', async () => {
    const manager = new BackgroundTaskManager();
    expect(await manager.awaitResult('missing', 0)).toEqual({ status: 'not_found' });
    const slow = manager.submit(7, async () => {
      await new Promise((r) => setTimeout(r, 400));
      return 'late';
    });
    // 超时不消费：结果仍留给下一轮自动注入
    expect(await manager.awaitResult(slow, 0)).toEqual({ status: 'pending' });
    expect(await manager.awaitResult(slow, 1000)).toEqual({ status: 'done', result: 'late' });
    const ok = manager.submit(7, () => 'ok');
    expect(await manager.awaitResult(ok, 1)).toEqual({ status: 'done', result: 'ok' });
    expect(await manager.awaitResult(ok, 1)).toEqual({ status: 'not_found' });
    const failed = manager.submit(7, () => { throw new Error('bad'); });
    const failure = await manager.awaitResult(failed, 1);
    expect(failure.status).toBe('done');
    expect(failure.status === 'done' && failure.result).toContain('Error: bad');
    // 归属校验：其他会话不得领取
    const owned = manager.submit(7, () => 'mine');
    expect(await manager.awaitResult(owned, 1, 8)).toEqual({ status: 'not_found' });
    expect(await manager.awaitResult(owned, 1, 7)).toEqual({ status: 'done', result: 'mine' });
  });

  it('keepsSessionIdAndResumeHintForUnfinishedShellResults', async () => {
    const manager = new BackgroundTaskManager();
    const task = manager.submit(5, () => JSON.stringify({
      exit_code: -1,
      completed: false,
      output: 'Listening on 3000\n',
      session_id: 'sh-dev',
      matched: 'Listening on',
      message: "等待超时，命令仍在运行。用 action:'await_async' 继续等待。",
    }));
    const awaited = await manager.awaitResult(task, 1000, 5);
    expect(awaited.status).toBe('done');
    const payload = JSON.parse(awaited.status === 'done' ? awaited.result : '{}');
    expect(payload).toMatchObject({
      exit_code: -1,
      completed: false,
      session_id: 'sh-dev',
      matched: 'Listening on',
    });
    expect(payload.message).toContain('await_async');
  });

  it('normalizesShellJsonResultsWithExitCodeAndCompleted', async () => {
    const manager = new BackgroundTaskManager();
    const shellTask = manager.submit(5, () => JSON.stringify({ exit_code: 3, completed: true, output: 'step-1\nstep-2' }));
    const longOutputTask = manager.submit(5, () => JSON.stringify({ exit_code: 0, completed: true, output: 'y'.repeat(20001) }));
    await new Promise((r) => setTimeout(r, 50));
    const results = await manager.consumeCompletedResults(5);
    expect(JSON.parse(results[shellTask])).toMatchObject({ exit_code: 3, completed: true, output: 'step-1\nstep-2' });
    // output 预算内截断后重组仍是合法 JSON，且只带一个截断标记
    const normalizedLong = JSON.parse(results[longOutputTask]);
    expect(normalizedLong).toMatchObject({ exit_code: 0, completed: true });
    expect(normalizedLong.output).toMatch(/\.\.\. \[truncated\]$/);
    expect(results[longOutputTask].length).toBeLessThanOrEqual(10000 + 20);
  });
});

describe('CompositeAgentEventListener', () => {
  it('fansOutToAllListeners', () => {
    const a: string[] = [];
    const b: string[] = [];
    const recording = (sink: string[]): AgentEventListener => ({
      onContentDelta: (d) => sink.push('delta:' + d),
      onToolCallStart: (tc) => sink.push('toolStart:' + tc.id),
      onToolCallResult: (id) => sink.push('toolResult:' + id),
      onMessageEnd: () => sink.push('messageEnd'),
      onError: () => {},
      onThinkingStart: () => sink.push('thinkingStart'),
    });
    const composite = CompositeAgentEventListener.of(recording(a), recording(b));
    composite.onThinkingStart();
    composite.onContentDelta('hello');
    composite.onToolCallStart({ id: 'c1', function: { name: 'read_file', arguments: '{}' } });
    composite.onToolCallResult('c1', '{}');
    composite.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 3 });
    expect(a).toEqual(['thinkingStart', 'delta:hello', 'toolStart:c1', 'toolResult:c1', 'messageEnd']);
    expect(b).toEqual(a);
  });

  it('continuesWhenOneListenerThrows', () => {
    let okCalls = 0;
    const throwing: AgentEventListener = {
      onContentDelta: () => { throw new Error('boom'); },
      onToolCallStart: () => {},
      onToolCallResult: () => {},
      onMessageEnd: () => {},
      onError: () => {},
    };
    const ok: AgentEventListener = {
      onContentDelta: () => { okCalls++; },
      onToolCallStart: () => {},
      onToolCallResult: () => {},
      onMessageEnd: () => {},
      onError: () => {},
    };
    CompositeAgentEventListener.of(throwing, ok).onContentDelta('x');
    expect(okCalls).toBe(1);
  });

  it('ignoresNullListeners', () => {
    const events: string[] = [];
    CompositeAgentEventListener.of(null, {
      onContentDelta: (d) => events.push('delta:' + d),
      onToolCallStart: () => {},
      onToolCallResult: () => {},
      onMessageEnd: () => {},
      onError: () => {},
    }).onContentDelta('z');
    expect(events).toEqual(['delta:z']);
  });
});

describe('EnvironmentInfoProvider', () => {
  const provider = new EnvironmentInfoProvider();

  it('detectReportsGitWorkspaceAndRuntimeDefaults', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-env-'));
    mkdirSync(join(dir, 'repo', 'subdir'), { recursive: true });
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    const info = await provider.detect(join(dir, 'repo', 'subdir'));
    expect(info.isGit).toBe(true);
    expect(['darwin', 'linux', 'win32']).toContain(info.platform);
    expect(info.shell).toBeTruthy();
    expect(info.osVersion).toBeTruthy();
  });

  it('detectReturnsFalseWhenWorkspaceIsBlankOrNotGit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-env-'));
    expect((await provider.detect(null)).isGit).toBe(false);
    expect((await provider.detect(dir)).isGit).toBe(false);
  });

  it('fromSessionUsesLocalEnvironmentSnapshotForLocalMode', async () => {
    const info = await provider.fromSessionOrDetect({
      userId: 1,
      executionMode: 'LOCAL',
      isGit: true,
      platform: 'darwin',
      shellPath: '/bin/zsh',
      osVersion: 'Darwin 25.0',
    });
    expect(info.isGit).toBe(true);
    expect(info.platform).toBe('darwin');
    expect(info.shell).toBe('/bin/zsh');
    expect(info.osVersion).toBe('Darwin 25.0');
  });

  it('fromSessionMergesCloudSessionOverridesWithDetectedValues', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-env-'));
    mkdirSync(join(dir, '.git'), { recursive: true });
    const info = await provider.fromSessionOrDetect({
      userId: 1,
      executionMode: 'CLOUD',
      workspace: dir,
      isGit: false,
      platform: 'custom-platform',
      shellPath: 'custom-shell',
      osVersion: 'custom-os',
    });
    expect(info.isGit).toBe(false);
    expect(info.platform).toBe('custom-platform');
    expect(info.shell).toBe('custom-shell');
    expect(info.osVersion).toBe('custom-os');
  });
});

describe('SessionCompactionMapper SQL', () => {
  it('copiesCasUpdateExactlyFromJava', () => {
    expect(UPDATE_WITH_BOUNDARY_CAS).toContain('AND COALESCE(last_compacted_msg_id, 0) = #{expectedOldBoundary}');
    expect(UPDATE_WITH_BOUNDARY_CAS).toContain('AND #{newBoundary} > #{expectedOldBoundary}');
  });
});
