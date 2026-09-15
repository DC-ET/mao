import { describe, expect, it } from 'vitest';
import { LLM_CALL_SCENES, LlmCallContext } from './llm-call-context.js';

describe('LlmCallContext', () => {
  it('stores and retrieves scene context', () => {
    LlmCallContext.run({
      scene: LLM_CALL_SCENES.AGENT,
      userId: 1,
      sessionId: 2,
      agentId: 3,
    }, () => {
      expect(LlmCallContext.get()).toEqual({
        scene: 'agent',
        userId: 1,
        sessionId: 2,
        agentId: 3,
      });
    });
  });

  it('nested run overrides scene but inherits missing ids', () => {
    LlmCallContext.run({
      scene: LLM_CALL_SCENES.AGENT,
      userId: 1,
      sessionId: 2,
      agentId: 3,
    }, () => {
      LlmCallContext.run({
        scene: LLM_CALL_SCENES.COMPACTION,
      }, () => {
        expect(LlmCallContext.get()).toEqual({
          scene: 'compaction',
          userId: 1,
          sessionId: 2,
          agentId: 3,
        });
      });
    });
  });
});
