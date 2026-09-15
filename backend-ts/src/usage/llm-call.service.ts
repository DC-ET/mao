import type { ChatUsage } from '../harness/llm/chat-request.js';
import { LlmCallContext } from './llm-call-context.js';
import type { LlmCallListFilter, LlmCallRepository, LlmCallRow } from './llm-call.repository.js';

export interface LlmCallModelConfig {
  id?: number;
  name?: string | null;
  provider?: string | null;
  apiProtocol?: string | null;
  effort?: string | null;
  modelId?: string;
}

export interface LlmCallRecordInput {
  modelConfig: LlmCallModelConfig;
  stream: boolean;
  usage?: ChatUsage | null;
  success: boolean;
  errorMessage?: string | null;
  firstTokenMs?: number | null;
  durationMs: number;
  retryCount?: number;
}

export interface LlmCallListItem extends LlmCallRow {
  username?: string | null;
  displayName?: string | null;
  agentName?: string | null;
}

export class LlmCallService {
  constructor(
    private readonly repo: LlmCallRepository,
    private readonly userLookup?: { findUsername(id: number): Promise<{ username?: string | null; displayName?: string | null } | null> },
    private readonly agentLookup?: { findName(id: number): Promise<string | null> },
  ) {}

  async record(input: LlmCallRecordInput): Promise<void> {
    const ctx = LlmCallContext.get();
    const usage = input.usage;
    const cached = usage?.promptTokensDetails?.cachedTokens ?? 0;
    try {
      await this.repo.insert({
        userId: ctx?.userId ?? null,
        sessionId: ctx?.sessionId ?? null,
        agentId: ctx?.agentId ?? null,
        modelId: input.modelConfig.id ?? null,
        modelName: input.modelConfig.name ?? null,
        provider: input.modelConfig.provider ?? null,
        providerModelId: input.modelConfig.modelId ?? null,
        scene: ctx?.scene ?? 'unknown',
        stream: input.stream ? 1 : 0,
        effort: input.modelConfig.effort ?? null,
        protocol: input.modelConfig.apiProtocol ?? null,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        cachedTokens: cached ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        success: input.success ? 1 : 0,
        errorMessage: truncateError(input.errorMessage),
        firstTokenMs: input.firstTokenMs ?? null,
        durationMs: input.durationMs,
        retryCount: input.retryCount ?? 0,
      });
    } catch (e) {
      console.warn(`[llm-call] failed to persist call record: ${(e as Error).message}`);
    }
  }

  async listForAdmin(
    page: number,
    size: number,
    filter: LlmCallListFilter,
  ): Promise<{ records: LlmCallListItem[]; total: number; page: number; size: number }> {
    const clampedSize = Math.min(Math.max(size, 1), 100);
    const result = await this.repo.list(Math.max(page, 1), clampedSize, filter);
    const records = await this.enrichRecords(result.records);
    return { records, total: result.total, page: Math.max(page, 1), size: clampedSize };
  }

  async listForUser(
    userId: number,
    page: number,
    size: number,
    filter: Omit<LlmCallListFilter, 'userId'>,
  ): Promise<{ records: LlmCallListItem[]; total: number; page: number; size: number }> {
    return this.listForAdmin(page, size, { ...filter, userId });
  }

  private async enrichRecords(records: LlmCallRow[]): Promise<LlmCallListItem[]> {
    const userIds = [...new Set(records.map((r) => r.userId).filter((id): id is number => id != null))];
    const agentIds = [...new Set(records.map((r) => r.agentId).filter((id): id is number => id != null))];
    const userMap = new Map<number, { username?: string | null; displayName?: string | null }>();
    const agentMap = new Map<number, string>();
    if (this.userLookup) {
      await Promise.all(userIds.map(async (id) => {
        const user = await this.userLookup!.findUsername(id);
        if (user) userMap.set(id, user);
      }));
    }
    if (this.agentLookup) {
      await Promise.all(agentIds.map(async (id) => {
        const name = await this.agentLookup!.findName(id);
        if (name) agentMap.set(id, name);
      }));
    }
    return records.map((row) => ({
      ...row,
      username: row.userId != null ? userMap.get(row.userId)?.username ?? null : null,
      displayName: row.userId != null ? userMap.get(row.userId)?.displayName ?? null : null,
      agentName: row.agentId != null ? agentMap.get(row.agentId) ?? null : null,
    }));
  }
}

function truncateError(message: string | null | undefined): string | null {
  if (message == null || message.trim() === '') return null;
  const trimmed = message.trim();
  return trimmed.length > 512 ? trimmed.slice(0, 512) : trimmed;
}
