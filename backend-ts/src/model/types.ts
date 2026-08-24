import type { ClientImpersonation, ModelVO, ModelPageResult, ModelListFilter } from '@mao/contracts';
export type { ClientImpersonation, ModelVO, ModelPageResult, ModelListFilter };

export interface LlmModel {
  id?: number;
  name: string;
  provider?: string | null;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  modelType?: string | null;
  clientImpersonation?: string | null;
  contextWindowTokens?: number | null;
  status?: number | null;
  supportsVision?: number | null;
  isDefault?: number | null;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ModelTestResult {
  connectivity: boolean;
  midSystemMessage?: boolean;
  connectivityOutput?: string | null;
  midSystemMessageOutput?: string | null;
  error?: string | null;
  durationMs: number;
  audioTest?: boolean;
  audioFormat?: string | null;
  audioData?: string | null;
  audioSizeBytes?: number | null;
  audioSampleRate?: number | null;
  audioDurationMs?: number | null;
  audioVoice?: string | null;
}

export interface LlmModelRepository {
  selectPage(
    page: number,
    size: number,
    filter: ModelListFilter,
  ): Promise<{ records: LlmModel[]; total: number }>;
  listProviders(): Promise<string[]>;
  listActiveText(): Promise<LlmModel[]>;
  findFirstActiveByType(modelType: string): Promise<LlmModel | null>;
  findDefault(): Promise<LlmModel | null>;
  findById(id: number): Promise<LlmModel | null>;
  insert(model: LlmModel): Promise<number>;
  updateById(model: LlmModel): Promise<void>;
  deleteById(id: number): Promise<void>;
  clearDefaultFlag(): Promise<void>;
  countActiveExcept(id: number): Promise<number>;
}

export interface SessionModelRepository {
  reassignModelId(fromId: number, toId: number | null): Promise<void>;
}

export interface LlmChatMessage {
  role: string;
  content?: unknown;
  audio?: {
    data?: string | null;
    format?: string | null;
    transcript?: string | null;
    duration?: number | null;
  } | null;
}

export interface LlmChatRequest {
  messages: LlmChatMessage[];
  stream?: boolean;
  audio?: Record<string, unknown>;
  temperature?: number;
}

export interface LlmChatResponse {
  choices?: Array<{
    message?: LlmChatMessage | null;
    finish_reason?: string;
  }>;
}

export interface LlmModelConfig {
  id?: number;
  name?: string;
  provider?: string | null;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  clientImpersonation?: ClientImpersonation;
  supportsVision?: boolean;
}

export interface LlmChatClient {
  chat(request: LlmChatRequest, config: LlmModelConfig): Promise<LlmChatResponse>;
}
