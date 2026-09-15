import { AsyncLocalStorage } from 'node:async_hooks';

export const LLM_CALL_SCENES = {
  AGENT: 'agent',
  COMPACTION: 'compaction',
  SESSION_TITLE: 'session_title',
  GIT_COMMIT_MESSAGE: 'git_commit_message',
  DANGER_ASSESS: 'danger_assess',
  VOICE_SYNTHESIS: 'voice_synthesis',
  FEISHU_SUMMARIZE: 'feishu_summarize',
  CONNECTIVITY_TEST: 'connectivity_test',
  UNKNOWN: 'unknown',
} as const;

export type LlmCallScene = typeof LLM_CALL_SCENES[keyof typeof LLM_CALL_SCENES];

export interface LlmCallContextValue {
  scene: LlmCallScene | string;
  userId?: number | null;
  sessionId?: number | null;
  agentId?: number | null;
}

const storage = new AsyncLocalStorage<LlmCallContextValue>();

export const LlmCallContext = {
  get(): LlmCallContextValue | undefined {
    return storage.getStore();
  },

  run<T>(value: LlmCallContextValue, fn: () => T): T {
    const parent = storage.getStore();
    const merged: LlmCallContextValue = {
      scene: value.scene,
      userId: value.userId ?? parent?.userId ?? null,
      sessionId: value.sessionId ?? parent?.sessionId ?? null,
      agentId: value.agentId ?? parent?.agentId ?? null,
    };
    return storage.run(merged, fn);
  },

  async runAsync<T>(value: LlmCallContextValue, fn: () => Promise<T>): Promise<T> {
    const parent = storage.getStore();
    const merged: LlmCallContextValue = {
      scene: value.scene,
      userId: value.userId ?? parent?.userId ?? null,
      sessionId: value.sessionId ?? parent?.sessionId ?? null,
      agentId: value.agentId ?? parent?.agentId ?? null,
    };
    return storage.run(merged, fn);
  },
};
