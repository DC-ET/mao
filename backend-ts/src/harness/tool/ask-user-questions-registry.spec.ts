import { describe, expect, it } from 'vitest';
import { AskUserQuestionsRegistry } from './ask-user-questions-registry.js';

describe('AskUserQuestionsRegistry', () => {
  it('waitForAnswerReturnsStructuredResultOnClientAnswer', async () => {
    const registry = new AskUserQuestionsRegistry();
    const requestId = registry.register(11, [{ id: 'q1' }], null);
    const waiting = registry.waitForAnswer(11, requestId);
    expect(registry.complete(11, requestId, '{"answers":[{"id":"a"}]}')).toBe(true);
    const result = await waiting;
    expect(result).toEqual({ answered: true, cancelled: false, resultJson: '{"answers":[{"id":"a"}]}' });
  });

  it('waitForAnswerMarksCancelledWhenSessionFailsAll', async () => {
    const registry = new AskUserQuestionsRegistry();
    const requestId = registry.register(11, [{ id: 'q1' }], null);
    const waiting = registry.waitForAnswer(11, requestId);
    registry.failAllForSession(11);
    const result = await waiting;
    // 会话停止/中止走 resolve 通道，但必须带取消标记供 dispatcher 广播事件
    expect(result.answered).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(JSON.parse(result.resultJson)).toMatchObject({ error: 'Session cancelled', cancelled: true });
  });

  it('waitForAnswerReportsMissingEntryWithoutCancel', async () => {
    const registry = new AskUserQuestionsRegistry();
    const result = await registry.waitForAnswer(11, 'missing');
    expect(result).toMatchObject({ answered: false, cancelled: false });
    expect(JSON.parse(result.resultJson)).toHaveProperty('error');
  });
});
