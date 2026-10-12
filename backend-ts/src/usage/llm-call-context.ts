import { AsyncLocalStorage } from 'node:async_hooks';
import type { LlmCallScene } from '@mao/contracts';

/**
 * LLM 调用场景的事实源。值集合必须与 `@mao/contracts` 的 `LlmCallScene`
 * 联合类型一一对应——该类型是前端汉化表（`Record<LlmCallScene, string>`）的
 * 编译期依据，漏一项会让两端展示英文枚举且筛选缺项。
 *
 * 加新场景时同步 contracts 的 `usage.ts`；本对象到契约的一致性由
 * 本文件末尾的 `_AssertExhaustive` 断言守住。
 */
export const LLM_CALL_SCENES = {
  AGENT: 'agent',
  COMPACTION: 'compaction',
  SESSION_TITLE: 'session_title',
  GIT_COMMIT_MESSAGE: 'git_commit_message',
  FEEDBACK_EXPERIENCE_DRAFT: 'feedback_experience_draft',
  DANGER_ASSESS: 'danger_assess',
  PROXY_APPROVE: 'proxy_approve',
  VOICE_SYNTHESIS: 'voice_synthesis',
  FEISHU_SUMMARIZE: 'feishu_summarize',
  CONNECTIVITY_TEST: 'connectivity_test',
  MEMORY_EXTRACT: 'memory_extract',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, LlmCallScene>;

/** 契约里的每个场景都必须在本对象有归属键：编译期即失败，不留到运行时。 */
type _AssertExhaustive = Exclude<LlmCallScene, typeof LLM_CALL_SCENES[keyof typeof LLM_CALL_SCENES]> extends never
  ? true
  : never;
const _exhaustive: _AssertExhaustive = true;
void _exhaustive;

export type { LlmCallScene };

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
