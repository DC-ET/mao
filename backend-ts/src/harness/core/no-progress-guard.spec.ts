import { afterEach, describe, expect, it } from 'vitest';
import {
  NO_PROGRESS_ABORT_AT,
  NO_PROGRESS_EXEMPT_TOOLS,
  NoProgressGuard,
  NoProgressLoopException,
} from './no-progress-guard.js';
import { roundSignature, scanNoProgressNotices, type NoProgressCall, type NoProgressTail } from './no-progress-notice.js';
import type { ChatMessage } from '../llm/chat-request.js';

function call(overrides: Partial<NoProgressCall> = {}): NoProgressCall {
  return {
    toolName: 'grep_search',
    argumentsJson: '{"path":"backend-ts/src/feishu","pattern":"群名"}',
    resultContent: '{"total_matches":0,"matches":[]}',
    ...overrides,
  };
}

/** 走一轮：先 observe 再 endRound，返回本轮动作。 */
function runRound(guard: NoProgressGuard, calls: NoProgressCall[], anchor = 'call-1') {
  for (const item of calls) guard.observeCall(item);
  guard.endRound(anchor);
  return guard.takeAction();
}

function tailFor(streak: number, calls: NoProgressCall[] = [call()], nudgedAt: number[] = []): NoProgressTail {
  return { streak, lastRoundKey: roundSignature(calls), nudgedAt };
}

describe('NoProgressGuard', () => {
  afterEach(() => {
    NO_PROGRESS_EXEMPT_TOOLS.clear();
  });

  it('nudges at 5 and 10 then aborts at 15', () => {
    const guard = new NoProgressGuard();
    const actions: Array<string | null> = [];
    for (let round = 1; round <= NO_PROGRESS_ABORT_AT; round++) {
      const action = runRound(guard, [call()], `call-${round}`);
      actions.push(action == null ? null : action.kind);
    }
    expect(actions.slice(0, 4)).toEqual([null, null, null, null]);
    expect(actions[4]).toBe('nudge');
    expect(actions.slice(5, 9)).toEqual([null, null, null, null]);
    expect(actions[9]).toBe('nudge');
    expect(actions.slice(10, 14)).toEqual([null, null, null, null]);
    expect(actions[14]).toBe('abort');
  });

  it('nudges only once per streak value and exposes the anchor + tool names', () => {
    const guard = new NoProgressGuard();
    for (let round = 1; round < 5; round++) expect(runRound(guard, [call()])).toBeNull();
    const action = runRound(guard, [call()], 'call-5');
    expect(action).toEqual(expect.objectContaining({ kind: 'nudge', afterToolCallId: 'call-5' }));
    expect(guard.takeAction()).toBeNull();
    expect(guard.streak).toBe(5);
    expect(guard.toolNames).toEqual(['grep_search']);
    expect(guard.digest).toHaveLength(16);
    expect(guard.argsLength).toBeGreaterThan(0);
  });

  it('resets the streak when the result changes', () => {
    const guard = new NoProgressGuard();
    expect(runRound(guard, [call()])).toBeNull();
    expect(runRound(guard, [call()])).toBeNull();
    expect(runRound(guard, [call({ resultContent: '{"total_matches":1}' })])).toBeNull();
    expect(guard.streak).toBe(1);
    // 改回原结果的第 1 轮仍是「相对上一轮变化」→ streak=1，需再连续 4 轮才到 5
    for (let i = 0; i < 4; i++) expect(runRound(guard, [call()])).toBeNull();
    expect(guard.streak).toBe(4);
    expect(runRound(guard, [call()])?.kind).toBe('nudge');
  });

  it('treats reordered argument keys as the same call and a changed value as progress', () => {
    const guard = new NoProgressGuard();
    for (let round = 1; round <= 4; round++) {
      runRound(guard, [call({ argumentsJson: '{"pattern":"群名","path":"backend-ts/src/feishu"}' })]);
    }
    expect(runRound(guard, [call({ argumentsJson: '{"path":"backend-ts/src/feishu","pattern":"群名"}' })])?.kind)
      .toBe('nudge');
    expect(runRound(guard, [call({ argumentsJson: '{"path":"backend-ts/src/feishu","pattern":"别的"}' })])).toBeNull();
    expect(guard.streak).toBe(1);
  });

  it('resets on an empty round (no calls observed)', () => {
    const guard = new NoProgressGuard();
    for (let round = 1; round <= 3; round++) runRound(guard, [call()]);
    expect(guard.streak).toBe(3);
    expect(runRound(guard, [])).toBeNull();
    expect(guard.streak).toBe(0);
  });

  it('treats a round made only of tool-level exempt tools as an empty round', () => {
    NO_PROGRESS_EXEMPT_TOOLS.add('task_list');
    const guard = new NoProgressGuard();
    for (let round = 1; round <= 3; round++) runRound(guard, [call()]);
    runRound(guard, [call({ toolName: 'task_list' })]);
    expect(guard.streak).toBe(0);
  });

  it('does not advance the streak for shell waits and timed-out subagent waits', () => {
    const guard = new NoProgressGuard();
    for (let round = 1; round <= NO_PROGRESS_ABORT_AT + 2; round++) {
      const action = runRound(guard, [
        call({ toolName: 'shell', argumentsJson: '{"action":"await_async","session_id":"sh-1"}', resultContent: '{"completed":false}' }),
        call({ toolName: 'wait_subagents', argumentsJson: '{}', resultContent: '{"timed_out":true}' }),
      ]);
      expect(action).toBeNull();
    }
    expect(guard.streak).toBe(0);
  });

  it('seeds from a scanned tail so a resumed execution keeps counting', () => {
    const guard = new NoProgressGuard(tailFor(4));
    expect(guard.streak).toBe(4);
    expect(runRound(guard, [call()], 'call-5')).toEqual(expect.objectContaining({ kind: 'nudge' }));

    const nearAbort = new NoProgressGuard(tailFor(14, [call()], [5, 10]));
    expect(runRound(nearAbort, [call()])).toEqual({ kind: 'abort' });
  });

  it('resetFrom replaces streak / key / nudgedAt entirely', () => {
    const guard = new NoProgressGuard(tailFor(4));
    runRound(guard, [call()]);
    expect(guard.streak).toBe(5);
    guard.resetFrom(tailFor(2, [call({ resultContent: '{"other":1}' })], []));
    expect(guard.streak).toBe(2);
    expect(guard.digest).toBe('');
    guard.resetFrom(null);
    expect(guard.streak).toBe(0);
  });

  it('stays consistent with the history scanner: same tail and same action sequence', () => {
    const messages: ChatMessage[] = [];
    for (let round = 1; round <= 6; round++) {
      messages.push({
        role: 'assistant',
        content: '',
        toolCalls: [{ id: `call-${round}`, function: { name: 'grep_search', arguments: call().argumentsJson } }],
      });
      messages.push({ role: 'tool', toolCallId: `call-${round}`, content: call().resultContent });
    }
    const scanned = scanNoProgressNotices(messages);
    expect(scanned.tail).not.toBeNull();

    const guard = new NoProgressGuard();
    for (let round = 1; round <= 6; round++) runRound(guard, [call()], `call-${round}`);
    expect(guard.streak).toBe(scanned.tail!.streak);
    expect(guard.takeAction()).toBeNull();

    const resumed = new NoProgressGuard(scanned.tail);
    expect(runRound(resumed, [call()], 'call-7')).toBeNull();
    expect(runRound(resumed, [call()], 'call-8')).toBeNull();
    expect(runRound(resumed, [call()], 'call-9')).toBeNull();
    expect(runRound(resumed, [call()], 'call-10')?.kind).toBe('nudge');
  });

  it('describes the aborted loop without leaking arguments', () => {
    const error = new NoProgressLoopException(['grep_search', 'glob_search'], 15);
    expect(error.name).toBe('NoProgressLoopException');
    expect(error.message).toContain('连续 15 轮');
    expect(error.message).toContain('grep_search/glob_search');
    expect(error.message).not.toContain('群名');
  });
});
