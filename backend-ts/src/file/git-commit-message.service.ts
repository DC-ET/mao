import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { ClientImpersonation } from '@mao/contracts';
import { AtomicBoolean } from '../harness/atomic-boolean.js';
import { hasText } from '../common/case.js';
import type { LlmModelRef, Session } from '../session/types.js';
import { LlmUsageService } from '../usage/llm-usage.service.js';
import { GIT_COMMIT_MESSAGE_MODEL_ID_KEY } from '../settings/settings.service.js';

export const MAX_DIFF_BYTES = 200 * 1024;
export const MAX_FILES = 5000;
const MAX_PATH_LENGTH = 1024;
const MAX_CHANGE_TYPE_LENGTH = 32;
const TIMEOUT_SECONDS = 60;
const TITLE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: .+$/;
const CHINESE = /[\u4e00-\u9fff]/;
const SYSTEM_PROMPT = `你只生成 Git 提交信息，不解释。标题必须符合 Conventional Commits：type 和可选 scope 使用英文，冒号后的描述使用简体中文。标题后空一行，正文至少一条且每个非空行都以“- ”开头并使用简体中文。不要臆测元数据或 diff 未体现的改动。敏感、二进制或截断文件只能依据元数据概括。禁止 Markdown 代码围栏。`;

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatRequest {
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
  stream: boolean;
  temperature: number;
  reasoning?: { effort: string };
  thinking?: { type: string };
  enableThinking?: boolean;
}

export interface ChatResponse {
  usage?: ChatUsage | null;
  choices?: Array<{ message?: { content?: unknown } }>;
}

export interface LlmAdapter {
  chat(request: ChatRequest, config: LlmModelConfig, cancelFlag?: { get(): boolean } | null): Promise<ChatResponse>;
}

export interface LlmModelConfig {
  id?: number;
  name?: string | null;
  provider?: string | null;
  apiProtocol?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
  modelId?: string | null;
  contextWindowTokens?: number | null;
  supportsVision?: boolean;
  clientImpersonation?: ClientImpersonation;
}

export interface HarnessModelResolver {
  resolveModel(modelId: number | null | undefined): Promise<LlmModelRef | null> | LlmModelRef | null;
}

export interface SettingLookup {
  getValue(key: string): Promise<string | null>;
}

export interface CommitFile {
  path: string;
  changeType: string;
  insertions: number;
  deletions: number;
  binary?: boolean;
  sensitive?: boolean;
  truncated?: boolean;
  diff?: string | null;
}

export interface CommitGenerationInput {
  files: CommitFile[];
  truncated?: boolean;
  diffBytes: number;
}

export interface CommitMessage {
  title: string;
  message: string;
}

export class GitCommitMessageService {
  static readonly MAX_DIFF_BYTES = MAX_DIFF_BYTES;
  static readonly MAX_FILES = MAX_FILES;

  constructor(
    private readonly llmAdapter: LlmAdapter,
    private readonly harnessService: HarnessModelResolver,
    private readonly usageService: LlmUsageService,
    private readonly settingLookup: SettingLookup,
  ) {}

  async generate(session: Session, input: CommitGenerationInput): Promise<CommitMessage> {
    this.validateInput(input);
    const model = await this.resolveCommitModel();
    if (model == null) throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
    const config = toConfig(model);
    const userPrompt = this.serialize(input);
    const first = await this.invoke(session, model, config, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ]);
    const error = validateMessage(first);
    if (error == null) return parse(first);

    const second = await this.invoke(session, model, config, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: first },
      { role: 'user', content: `上次输出格式不合规：${error}。请仅输出修正后的完整提交信息。` },
    ]);
    const secondError = validateMessage(second);
    if (secondError != null) {
      throw new BusinessException(ErrorCode.LLM_CALL_FAILED, `提交信息格式连续两次不合规：${secondError}`);
    }
    return parse(second);
  }

  validateInput(input: CommitGenerationInput | null | undefined): void {
    if (input == null || input.files == null || input.files.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '变更摘要不能为空');
    }
    if (input.files.length > MAX_FILES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '变更文件数量过多');
    }
    let actualDiffBytes = 0;
    for (const file of input.files) {
      if (
        file == null || blank(file.path) || file.path.length > MAX_PATH_LENGTH
        || blank(file.changeType) || file.changeType.length > MAX_CHANGE_TYPE_LENGTH
        || file.insertions < 0 || file.deletions < 0
      ) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '变更摘要字段无效');
      }
      if ((file.sensitive || file.binary) && !blank(file.diff ?? null)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '敏感或二进制文件不得包含 diff');
      }
      if (file.diff != null) actualDiffBytes += Buffer.byteLength(file.diff, 'utf8');
      if (actualDiffBytes > MAX_DIFF_BYTES) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'diff 超过 200KB 限制');
      }
    }
    if (input.diffBytes < 0 || input.diffBytes > MAX_DIFF_BYTES || input.diffBytes !== actualDiffBytes) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'diffBytes 与实际内容不一致');
    }
  }

  private async invoke(session: Session, model: LlmModelRef, config: LlmModelConfig, messages: ChatRequest['messages']): Promise<string> {
    const request: ChatRequest = {
      messages,
      tools: [],
      stream: false,
      temperature: 0.2,
      reasoning: { effort: 'none' },
      thinking: { type: 'disabled' },
      enableThinking: false,
    };
    let response: ChatResponse | null = null;
    let success = false;
    const cancelFlag = new AtomicBoolean(false);
    try {
      response = await withTimeout(this.llmAdapter.chat(request, config, cancelFlag), TIMEOUT_SECONDS * 1000, () => cancelFlag.set(true));
      const content = extractContent(response);
      success = true;
      return content;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      if ((e as Error).name === 'TimeoutError') {
        throw new BusinessException(ErrorCode.LLM_TIMEOUT, '提交信息生成超时');
      }
      throw new BusinessException(ErrorCode.LLM_CALL_FAILED, '提交信息生成失败');
    } finally {
      await this.usageService.record(
        session.userId, session.id ?? null, model.id, LlmUsageService.SCENE_GIT_COMMIT_MESSAGE,
        response?.usage ?? null, success,
      );
    }
  }

  private async resolveCommitModel(): Promise<LlmModelRef | null> {
    const configured = await this.settingLookup.getValue(GIT_COMMIT_MESSAGE_MODEL_ID_KEY);
    if (hasText(configured)) {
      const parsed = Number(configured!.trim());
      if (Number.isSafeInteger(parsed)) {
        const model = await this.harnessService.resolveModel(parsed);
        if (model) return model;
        console.warn(`[git-commit] configured commit message model ${configured} not found, fallback to default`);
      } else {
        console.warn(`[git-commit] invalid commit message model config: ${configured}, fallback to default`);
      }
    }
    return this.harnessService.resolveModel(null);
  }

  private serialize(input: CommitGenerationInput): string {
    return `请根据以下结构化变更生成提交信息：\n${JSON.stringify(input)}`;
  }
}

export function validateMessage(raw: string | null | undefined): string | null {
  if (blank(raw)) return '输出为空';
  const text = normalize(raw!);
  if (text.includes('```')) return '不得包含 Markdown 代码围栏';
  const lines = text.split('\n');
  if (!TITLE.test(lines[0])) return '标题不符合 Conventional Commits';
  const colon = lines[0].indexOf(': ');
  if (colon < 0 || !CHINESE.test(lines[0].slice(colon + 2))) return '标题描述必须包含简体中文';
  if (lines.length < 3 || lines[1].length !== 0) return '标题后必须有一个空行';
  let body = false;
  for (let i = 2; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    body = true;
    if (!lines[i].startsWith('- ')) return '正文非空行必须以 - 开头';
    if (!CHINESE.test(lines[i].slice(2))) return '正文必须使用简体中文';
  }
  return body ? null : '正文至少需要一条列表';
}

function extractContent(response: ChatResponse | null): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new BusinessException(ErrorCode.LLM_CALL_FAILED, '模型未返回提交信息');
  }
  return content;
}

function toConfig(model: LlmModelRef): LlmModelConfig {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    apiProtocol: model.apiProtocol,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
    modelId: model.modelId,
    contextWindowTokens: model.contextWindowTokens,
    supportsVision: model.supportsVision != null && model.supportsVision === 1,
    clientImpersonation: toClientImpersonation(model.clientImpersonation),
  };
}

function toClientImpersonation(value: string | null | undefined): ClientImpersonation {
  if (value === 'codex' || value === 'claude_code') return value;
  return 'none';
}

function parse(raw: string): CommitMessage {
  const text = normalize(raw);
  const newline = text.indexOf('\n');
  return { title: text.slice(0, newline), message: text };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function blank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout();
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
