import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { ClientImpersonation } from '@mao/contracts';
import { AtomicBoolean } from '../harness/atomic-boolean.js';
import { hasText } from '../common/case.js';
import type { LlmModelRef } from '../session/types.js';
import type { ChatRequest, ChatResponse, LlmAdapter, LlmModelConfig } from '../harness/llm/chat-request.js';
import { isSensitive } from '../file/git-write-operation.service.js';
import { extractStoredText } from '../memory/memory-extraction.service.js';
import { LlmUsageService } from '../usage/llm-usage.service.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../usage/llm-call-context.js';
import { FEEDBACK_DRAFT_MODEL_ID_KEY } from '../settings/settings.service.js';
import type { FeedbackReason } from './feedback.repository.js';
import type { RunTraceVO } from '../session/session-vo.js';

/** LLM 调用超时：起草只读不写，60s 足够；超时走 cancelFlag 中止流。 */
const TIMEOUT_SECONDS = 60;
/** 用户原话截断：单条点踩的用户意图通常几十字，1000 字足以覆盖粘贴的长需求。 */
const MAX_USER_TEXT_CHARS = 1000;
/** 被点踩回复截断：取回复主体，不含工具结果正文。 */
const MAX_ASSISTANT_TEXT_CHARS = 2000;
/** 单条 run 的轨迹行数上限：超过时只保留最后若干行（越晚越接近出错点）。 */
const MAX_TRACE_LINES = 60;
/** 单行轨迹的目标字段截断：命令串可能很长。 */
const MAX_TRACE_TARGET_CHARS = 120;
/** 输出经验条数钳制。 */
const MAX_EXPERIENCES = 2;
/** 与 AgentExperienceService.MAX_CONTENT_LENGTH 同口径（写入前服务端仍会复校验）。 */
const MAX_CONTENT_LENGTH = 300;

const SYSTEM_PROMPT = `你是 Agent 经验提炼器。根据用户点踩反馈与出事的运行轨迹，为指定的 Agent 提炼「最佳实践经验」，写入它的 system prompt 供后续执行参考。
要求：
1. 只输出 JSON，格式：{"experiences":[{"content":"..."}]}，不要任何解释、Markdown 或代码块标记；
2. 输出 1～2 条，每条是不超过 300 字的简体中文，形如「X 场景下优先 Y，避免 Z」；
3. 必须引用轨迹中真实出现的具体对象（文件名、命令、工具名、报错状态），禁止臆测轨迹未体现的行为；
4. 同一场景不要输出语义重复的多条；与该 Agent 已有经验重复的内容不要输出；
5. 不要复述用户原话，不要评价用户，只写给 Agent 的行为约束。`;

/** 单个反馈的原料：点踩行 + 该消息所在 run 的轨迹。 */
export interface DraftMaterial {
  reason: FeedbackReason;
  reasonLabel: string;
  /** 点踩的助手消息 id（用于定位 run 与取回复正文）。 */
  messageId: number;
  /** 用户原话（run 锚点 USER 消息正文，已截断）。 */
  userText: string;
  /** 被点踩的助手回复正文（已截断）。 */
  assistantText: string;
  /** 轨迹紧凑文本（只含工具名/目标/状态/耗时，不含工具结果正文）。 */
  traceText: string;
}

export interface ExperienceDraft {
  content: string;
}

export interface ExperienceDraftResult {
  experiences: ExperienceDraft[];
}

export interface DraftModelResolver {
  resolveModel(modelId: number | null | undefined): Promise<LlmModelRef | null> | LlmModelRef | null;
}

export interface DraftSettingLookup {
  getValue(key: string): Promise<string | null>;
}

export interface DraftExperienceCountLookup {
  /** 目标 Agent 现有经验条数（提示模型避免重复）。 */
  countByAgentId(agentId: number): Promise<number>;
}

export class ExperienceDraftService {
  constructor(
    private readonly llmAdapter: Pick<LlmAdapter, 'chat'>,
    private readonly modelResolver: DraftModelResolver,
    private readonly usageService: Pick<LlmUsageService, 'record'>,
    private readonly settingLookup: DraftSettingLookup,
    private readonly experienceCountLookup: DraftExperienceCountLookup,
  ) {}

  /**
   * 起草经验草稿（只读，不写任何状态；可反复调用）。
   *
   * 原料由调用方装配（FeedbackService 持有 feedback 仓储与消息查询），此处只负责
   * prompt 组装、LLM 调用、解析与一次纠错。N=1 走单条 prompt，N≥2 走归纳 prompt，
   * 由服务端按原料条数自动切换，前端无感。
   */
  async draft(operatorId: number, agentId: number | null, materials: DraftMaterial[]): Promise<ExperienceDraftResult> {
    if (materials.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '没有可用的点踩反馈');
    }
    const model = await this.resolveDraftModel();
    if (model == null) throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
    const config = toConfig(model);

    const existingCount = agentId == null ? 0 : await this.experienceCountLookup.countByAgentId(agentId);
    const userPrompt = buildUserPrompt(materials, agentId, existingCount);
    const messages: ChatRequest['messages'] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];

    const first = await this.invoke(operatorId, agentId, model, config, messages);
    const firstError = validateExperiences(first);
    if (firstError == null) return { experiences: parseExperiences(first) };

    const second = await this.invoke(operatorId, agentId, model, config, [
      ...messages,
      { role: 'assistant', content: first },
      { role: 'user', content: `上次输出不合规：${firstError}。请仅输出修正后的 JSON。` },
    ]);
    const secondError = validateExperiences(second);
    if (secondError != null) {
      throw new BusinessException(ErrorCode.LLM_CALL_FAILED, `经验草稿格式连续两次不合规：${secondError}`);
    }
    return { experiences: parseExperiences(second) };
  }

  /** 照搬 GitCommitMessageService.invoke：LlmCallContext 包 scene + 超时 cancelFlag + finally 落用量。 */
  private async invoke(
    operatorId: number,
    agentId: number | null,
    model: LlmModelRef,
    config: LlmModelConfig,
    messages: ChatRequest['messages'],
  ): Promise<string> {
    const request: ChatRequest = {
      messages,
      tools: [],
      stream: false,
      temperature: 0.3,
      reasoning: { effort: 'none' },
      thinking: { type: 'disabled' },
      enableThinking: false,
    };
    let response: ChatResponse | null = null;
    let success = false;
    const cancelFlag = new AtomicBoolean(false);
    try {
      response = await withTimeout(
        LlmCallContext.runAsync({
          scene: LLM_CALL_SCENES.FEEDBACK_EXPERIENCE_DRAFT,
          // userId 记操作管理员：这是管理动作，不是点踩用户的请求
          userId: operatorId,
          sessionId: null,
          agentId,
        }, async () => this.llmAdapter.chat(request, config, cancelFlag)),
        TIMEOUT_SECONDS * 1000,
        () => cancelFlag.set(true),
      );
      const content = extractContent(response);
      success = true;
      return content;
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      if ((e as Error).name === 'TimeoutError') {
        throw new BusinessException(ErrorCode.LLM_TIMEOUT, '经验草稿生成超时');
      }
      throw new BusinessException(ErrorCode.LLM_CALL_FAILED, '经验草稿生成失败');
    } finally {
      await this.usageService.record(
        operatorId, null, model.id, LlmUsageService.SCENE_FEEDBACK_EXPERIENCE_DRAFT,
        response?.usage ?? null, success,
      );
    }
  }

  /** 模型解析：feedback.draftModelId 未配置 / 配了不存在的 id / 非法值均回落默认模型。 */
  private async resolveDraftModel(): Promise<LlmModelRef | null> {
    const configured = await this.settingLookup.getValue(FEEDBACK_DRAFT_MODEL_ID_KEY);
    if (hasText(configured)) {
      const parsed = Number(configured!.trim());
      if (Number.isSafeInteger(parsed)) {
        const model = await this.modelResolver.resolveModel(parsed);
        if (model) return model;
        console.warn(`[feedback-draft] configured draft model ${configured} not found, fallback to default`);
      } else {
        console.warn(`[feedback-draft] invalid draft model config: ${configured}, fallback to default`);
      }
    }
    return this.modelResolver.resolveModel(null);
  }
}

/** run 轨迹序列化为紧凑文本：只取工具名 / 目标 / 状态 / 耗时，不取工具结果正文。 */
export function serializeRunTrace(run: RunTraceVO): string {
  const lines: string[] = [];
  for (const segment of run.segments) {
    if (segment.kind === 'before_edit') lines.push('[编辑前]');
    for (const round of segment.rounds) {
      for (const tool of round.tools) lines.push(formatTraceLine(tool.name, tool.target, tool.status, tool.durationMs));
    }
    for (const tool of segment.unplacedTools) {
      lines.push(formatTraceLine(tool.name, tool.target, tool.status, tool.durationMs));
    }
  }
  if (lines.length === 0) return '（该轮没有任何工具调用记录）';
  return lines.length > MAX_TRACE_LINES
    ? `（轨迹过长，仅保留最后 ${MAX_TRACE_LINES} 行）\n${lines.slice(-MAX_TRACE_LINES).join('\n')}`
    : lines.join('\n');
}

function formatTraceLine(name: string, target: string | null, status: string, durationMs: number | null): string {
  // 脱敏只走 isSensitive 路径规则（与 git 提交信息同口径）：不做命令内容正则
  const shown = target == null || target === '' ? '' : isSensitive(target) ? ' [sensitive]' : ` ${truncate(target, MAX_TRACE_TARGET_CHARS)}`;
  const duration = durationMs == null ? '' : ` (${(durationMs / 1000).toFixed(1)}s)`;
  return `- ${name}${shown} [${status}]${duration}`;
}

/** N=1 单条 prompt / N≥2 归纳 prompt：同一次请求只走其中一种。 */
function buildUserPrompt(materials: DraftMaterial[], agentId: number | null, existingCount: number): string {
  const single = materials.length === 1;
  const head = single
    ? '以下是一条用户点踩反馈与出事轮次的运行轨迹。请基于这一次反馈提炼 1 条经验。'
    : `以下是 ${materials.length} 条用户点踩反馈与各自出事轮次的运行轨迹。请归纳出 1～2 条更通用的经验，覆盖这些反馈共同暴露的问题。`;
  const target = agentId == null ? '目标 Agent 未指定' : `目标 Agent id=${agentId}（已有 ${existingCount} 条经验）`;
  const sections = materials.map((material, index) => [
    `### 反馈 ${index + 1}`,
    `点踩原因：${material.reasonLabel}`,
    `用户原话：\n${material.userText || '（空）'}`,
    `被点踩的回复：\n${material.assistantText || '（空）'}`,
    `工具轨迹：\n${material.traceText}`,
  ].join('\n'));
  return `${head}\n${target}\n\n${sections.join('\n\n')}`;
}

/** 输出解析：非法 JSON / 条数越界 / 内容越界返回错误信息；合法则返回钳制后的条目。 */
export function validateExperiences(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return '输出为空';
  const text = normalize(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return '输出不是合法 JSON';
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return '输出必须是 JSON 对象';
  const list = (parsed as Record<string, unknown>).experiences;
  if (!Array.isArray(list)) return '缺少 experiences 数组';
  if (list.length === 0) return 'experiences 不能为空';
  if (list.length > MAX_EXPERIENCES) return `experiences 最多 ${MAX_EXPERIENCES} 条`;
  for (const item of list) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) return 'experiences 元素必须是对象';
    const content = (item as Record<string, unknown>).content;
    if (typeof content !== 'string' || content.trim() === '') return '经验内容不能为空';
    if (content.trim().length > MAX_CONTENT_LENGTH) return `经验内容超过 ${MAX_CONTENT_LENGTH} 字`;
  }
  return null;
}

export function parseExperiences(raw: string): ExperienceDraft[] {
  const parsed = JSON.parse(normalize(raw)) as { experiences: Array<{ content: string }> };
  return parsed.experiences.slice(0, MAX_EXPERIENCES).map((item) => ({ content: item.content.trim() }));
}

function extractContent(response: ChatResponse | null): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new BusinessException(ErrorCode.LLM_CALL_FAILED, '模型未返回经验草稿');
  }
  return content;
}

function normalize(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const fenced = trimmed.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * 截断加省略号。按 Unicode 码点而非 UTF-16 码元计数：slice(0, max) 会把 emoji /
 * CJK 扩展 B 的代理对切成孤立高位代理，进 prompt 就是乱码。
 */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}…`;
}

export function truncateStoredText(content: string | null | undefined, max: number): string {
  return truncate(extractStoredText(content), max);
}

export const DRAFT_LIMITS = {
  MAX_USER_TEXT_CHARS,
  MAX_ASSISTANT_TEXT_CHARS,
  MAX_TRACE_LINES,
  MAX_TRACE_TARGET_CHARS,
  MAX_EXPERIENCES,
  MAX_CONTENT_LENGTH,
};

function toConfig(model: LlmModelRef): LlmModelConfig {
  return {
    id: model.id,
    name: model.name ?? undefined,
    provider: model.provider ?? undefined,
    apiProtocol: model.apiProtocol ?? undefined,
    baseUrl: model.baseUrl ?? undefined,
    apiKey: model.apiKey ?? undefined,
    modelId: model.modelId ?? undefined,
    contextWindowTokens: model.contextWindowTokens ?? undefined,
    supportsVision: model.supportsVision === 1,
    clientImpersonation: toClientImpersonation(model.clientImpersonation),
  };
}

function toClientImpersonation(value: string | null | undefined): ClientImpersonation {
  return value === 'codex' || value === 'claude_code' ? value : 'none';
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
