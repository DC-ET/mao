import type { Db } from '../db/db.js';

export interface LlmUsage {
  id?: number;
  userId?: number | null;
  sessionId?: number | null;
  modelId?: number | null;
  scene?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  success?: number | null;
  createdAt?: string | null;
}

export interface ChatUsageLike {
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
}

export class LlmUsageRepository {
  constructor(private readonly db: Db) {}

  async insert(row: LlmUsage): Promise<number> {
    return this.db.insert('llm_usage', {
      userId: row.userId,
      sessionId: row.sessionId,
      modelId: row.modelId,
      scene: row.scene,
      promptTokens: row.promptTokens ?? 0,
      completionTokens: row.completionTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
      success: row.success ?? 0,
    });
  }

  async sumByModelId(modelId: number): Promise<{ promptTokens: number; completionTokens: number; totalTokens: number; callCount: number }> {
    const row = await this.db.queryOne<{ promptTokens: number; completionTokens: number; totalTokens: number; callCount: number }>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
              COALESCE(SUM(completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(total_tokens), 0) AS totalTokens,
              COUNT(*) AS callCount
       FROM llm_usage WHERE model_id = ?`,
      [modelId],
    );
    return {
      promptTokens: Number(row?.promptTokens ?? 0),
      completionTokens: Number(row?.completionTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
      callCount: Number(row?.callCount ?? 0),
    };
  }
}

export class LlmUsageService {
  static readonly SCENE_GIT_COMMIT_MESSAGE = 'git_commit_message';

  constructor(private readonly repo: LlmUsageRepository) {}

  async record(
    userId: number | null | undefined,
    sessionId: number | null | undefined,
    modelId: number | null | undefined,
    scene: string,
    usage: ChatUsageLike | null | undefined,
    success: boolean,
  ): Promise<void> {
    await this.repo.insert({
      userId: userId ?? null,
      sessionId: sessionId ?? null,
      modelId: modelId ?? null,
      scene,
      promptTokens: usage != null ? usage.promptTokens ?? 0 : 0,
      completionTokens: usage != null ? usage.completionTokens ?? 0 : 0,
      totalTokens: usage != null ? usage.totalTokens ?? 0 : 0,
      success: success ? 1 : 0,
    });
  }
}
