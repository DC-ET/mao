import type { ChatResponse, LlmAdapter } from '../harness/llm/chat-request.js';
import type { LlmModel } from '../domain/types.js';
import { llmModelToConfig } from '../harness/deps.js';
import { AtomicBoolean } from '../harness/atomic-boolean.js';
import { hasText } from '../common/case.js';
import { LlmCallContext, LLM_CALL_SCENES } from '../usage/llm-call-context.js';
import { MEMORY_EXTRACTION_MODEL_ID_KEY } from '../settings/settings.service.js';
import { computeDedupHash, isRobotChannelProjectKey, memoryContentLength, normalizeMemoryContent } from './memory.service.js';
import { isDuplicateKeyError, type MemoryRepository } from './memory.repository.js';
import type { MemoryItemRow, MemoryScope } from './types.js';
import {
  MEMORY_ACTIVE_LIMIT,
  MEMORY_EXTRACT_CONTENT_MAX_LENGTH,
  MEMORY_EXTRACT_DISMISSED_HINT_LIMIT,
  MEMORY_EXTRACT_INPUT_MAX_CHARS,
  MEMORY_EXTRACT_MAX_ITEMS,
  MEMORY_EXTRACT_MIN_USER_MESSAGE_LENGTH,
} from './types.js';

const EXTRACTION_TIMEOUT_MS = 30_000;

const EXTRACTION_SYSTEM_PROMPT = `你是长期记忆抽取器。从给出的最后一轮对话中提取值得长期记住的信息，用于跨会话注入。
要求：
1. 只提取明确的长期事实或偏好：用户个人偏好（如输出语言、格式习惯、常用工具）与关于当前项目/仓库的稳定事实（如构建工具、测试框架、代码规范）；
2. 猜测、寒暄、情绪表达、一次性任务细节与临时上下文一律不抽取；
3. 每条标注 type："user"（用户个人偏好）或 "project"（关于当前项目/仓库的事实）；
4. 每条 content 不超过 120 字，使用对话原话的语言，表述完整独立（脱离本会话也能看懂）；
5. 最多输出 3 条；没有值得记住的内容时输出 []；
6. <known_memories> 是已知记忆（按 用户级 / 项目级 分组，每行形如 "id:N 内容"）：
   - 候选与其中某条语义相同时不要重复抽取：action 填 "touch"、existingId 填该行 id，表示再次确认；
   - 候选是同一事实的更完整表述时，action 填 "update"、existingId 填该行 id，并用 content 给出更完整的新表述；
   - 候选是全新事实时 action 填 "insert"、不填 existingId；
   - user 类型只能匹配用户级组的 id，project 类型只能匹配项目级组的 id；
   - 禁止使用不在 <known_memories> 中的 existingId；
   - touch 不需要 content，update 与 insert 必须给出 content；
7. <ignored_memories> 是用户已忽略的内容：禁止抽取与其语义相近的新记忆；
8. 只输出 JSON 数组，格式：[{"type":"user|project","action":"insert|touch|update","existingId":123,"content":"..."}]，不要任何解释、Markdown 或代码块标记。`;

/** 抽取输出的原始候选条目。 */
interface RawExtractionItem {
  type?: unknown;
  content?: unknown;
  action?: unknown;
  existingId?: unknown;
}

/** 候选动作：insert 插新行 / touch 再确认刷 updated_at / update 改写内容（D13）。 */
export type ExtractionAction = 'insert' | 'touch' | 'update';

export interface ExtractionCandidate {
  scope: MemoryScope;
  content: string;
  action: ExtractionAction;
  existingId: number | null;
}

/** D13 比较集索引：rows 供 prompt 展示，byId 供动作引用合法性校验（组内匹配）。 */
export interface KnownMemoryIndex {
  rows: MemoryItemRow[];
  byId: Map<number, MemoryItemRow>;
}

export interface ExtractionSessionInput {
  sessionId: number;
  userId: number | null | undefined;
  projectKey: string | null | undefined;
  workspace: string | null | undefined;
  agentId?: number | null;
}

export interface MessageTextLookup {
  selectLastUserMessage(sessionId: number): Promise<{ content?: string | null } | null>;
  selectLastAssistantMessage(sessionId: number): Promise<{ content?: string | null } | null>;
}

export interface ExtractionPreferenceLookup {
  /** 自动收集开关：默认关闭（无偏好行视为关闭），关闭时抽取直接短路。 */
  isAutoCaptureEnabled(userId: number): Promise<boolean>;
}

export interface ExtractionModelLookup {
  selectById(id: number): Promise<LlmModel | null>;
  selectDefault(): Promise<LlmModel | null>;
}

type SettingLookup = { getValue(key: string): Promise<string | null> };

export class MemoryExtractionService {
  /** 同会话并发互斥链：同一会话的任务串行抽取，避免并发重复调 LLM（技术方案 5.6 第 6 点）。 */
  private readonly sessionLocks = new Map<number, Promise<void>>();

  constructor(
    private readonly messageRepo: MessageTextLookup,
    private readonly memoryRepo: MemoryRepository,
    private readonly preferenceLookup: ExtractionPreferenceLookup,
    private readonly settingLookup: SettingLookup,
    private readonly modelLookup: ExtractionModelLookup,
    private readonly llmAdapter: LlmAdapter,
  ) {}

  /** 任务终态入口：fire-and-forget 调用，全程异常只记日志，绝不向上抛（不破坏任务完成事件链）。 */
  async extractForSession(input: ExtractionSessionInput): Promise<void> {
    if (input.sessionId == null || !Number.isSafeInteger(input.sessionId)) return;
    const sessionId = input.sessionId;
    const previous = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    const tail = previous.catch(() => undefined).then(() => this.doExtract(input));
    const tailSettled = tail.then(() => undefined, () => undefined);
    this.sessionLocks.set(sessionId, tailSettled);
    try {
      await tail;
    } finally {
      if (this.sessionLocks.get(sessionId) === tailSettled) {
        this.sessionLocks.delete(sessionId);
      }
    }
  }

  private async doExtract(input: ExtractionSessionInput): Promise<void> {
    const { sessionId } = input;
    try {
      if (input.userId == null) return;
      if (!(await this.preferenceLookup.isAutoCaptureEnabled(input.userId))) return;

      // 抽取输入（D8）：仅最后一轮 USER 消息 + 最后一条非空 ASSISTANT 答复，任一缺失跳过
      const [userMessage, assistantMessage] = await Promise.all([
        this.messageRepo.selectLastUserMessage(sessionId),
        this.messageRepo.selectLastAssistantMessage(sessionId),
      ]);
      const userText = extractStoredText(userMessage?.content ?? null);
      const assistantText = extractStoredText(assistantMessage?.content ?? null);
      if (!hasText(userText) || !hasText(assistantText)) return;

      // 短路（D11）：规范化后不足 20 字不调 LLM
      const normalizedUserMessage = normalizeMemoryContent(userText);
      if (memoryContentLength(normalizedUserMessage) < MEMORY_EXTRACT_MIN_USER_MESSAGE_LENGTH) return;

      const model = await this.resolveExtractionModel();
      if (model == null) {
        console.warn(`[memory-extraction] no extraction model available, skip sessionId=${sessionId}`);
        return;
      }

      // D13：比较集（存量 AUTO 记忆）+ 负面约束集（已忽略内容）与 invoke 并行加载；失败降级为空集
      const [known, dismissed] = await Promise.all([
        this.loadKnownMemories(input),
        this.loadDismissedHints(input.userId),
      ]);

      const raw = await this.invoke(userText, assistantText, model, input, known.rows, dismissed);
      const parsed = parseExtractionOutput(raw);
      if (!parsed.ok) {
        console.warn(`[memory-extraction] invalid LLM output, abandon sessionId=${sessionId}`);
        return;
      }
      if (parsed.count > MEMORY_EXTRACT_MAX_ITEMS) {
        console.warn(`[memory-extraction] output exceeds ${MEMORY_EXTRACT_MAX_ITEMS} items, abandon sessionId=${sessionId}`);
        return;
      }
      const candidates: ExtractionCandidate[] = [];
      for (const item of parsed.items) {
        const candidate = toCandidate(item);
        if (candidate) candidates.push(candidate);
      }
      if (candidates.length === 0) return;
      await this.persistCandidates(input, candidates, known);
    } catch (e) {
      console.warn(`[memory-extraction] failed sessionId=${sessionId}: ${(e as Error).message}`);
    }
  }

  /**
   * D13 比较集加载：USER 组全体 + 当前会话有效 projectKey 组的 AUTO ACTIVE 行。
   * 查询失败降级为空集（本轮退化为精确哈希路径，不阻断抽取）。
   */
  private async loadKnownMemories(input: ExtractionSessionInput): Promise<KnownMemoryIndex> {
    const byId = new Map<number, MemoryItemRow>();
    try {
      const groups: Array<{ scope: MemoryScope; projectKey: string | null }> = [{ scope: 'USER', projectKey: null }];
      if (hasText(input.projectKey) && !isRobotChannelProjectKey(input.projectKey, input.workspace)) {
        groups.push({ scope: 'PROJECT', projectKey: input.projectKey!.trim() });
      }
      for (const group of groups) {
        const rows = await this.memoryRepo.listActiveForDedup(input.userId!, group.scope, group.projectKey);
        for (const row of rows) {
          if (row.id != null && hasText(row.content)) byId.set(row.id, row);
        }
      }
    } catch (e) {
      console.warn(`[memory-extraction] failed to load known memories sessionId=${input.sessionId}: ${(e as Error).message}`);
      return { rows: [], byId: new Map() };
    }
    return { rows: [...byId.values()], byId };
  }

  /** D13 负面约束集：最近 DISMISSED 行 content（prompt 层约束，失败降级为空）。 */
  private async loadDismissedHints(userId: number): Promise<string[]> {
    try {
      const rows = await this.memoryRepo.listDismissedContents(userId, MEMORY_EXTRACT_DISMISSED_HINT_LIMIT);
      return rows.map((row) => normalizeMemoryContent(row.content)).filter(hasText);
    } catch (e) {
      console.warn(`[memory-extraction] failed to load dismissed hints userId=${userId}: ${(e as Error).message}`);
      return [];
    }
  }

  /** touch/update 引用校验：existingId 必须属于候选同组（scope + projectKey 一致）的比较集行。 */
  private resolveKnownReference(
    known: KnownMemoryIndex,
    existingId: number,
    scope: MemoryScope,
    projectKey: string,
  ): MemoryItemRow | null {
    const row = known.byId.get(existingId);
    if (row == null) return null;
    const rowScope: MemoryScope = row.scope === 'PROJECT' ? 'PROJECT' : 'USER';
    const rowKey = row.projectKey != null && row.projectKey !== '' ? row.projectKey : '';
    return rowScope === scope && rowKey === projectKey ? row : null;
  }

  /**
   * 落库（技术方案 5.6 第 5 点 + D13 动作协议 + D14 溢出自动降级）：
   * 逐候选按模型判定的 insert/touch/update 执行；满 200 时淘汰受影响组最旧 AUTO 行腾名额，
   * 组内无 AUTO 可淘汰则放弃该候选；DISMISSED 行永不复活不变。
   */
  private async persistCandidates(
    input: ExtractionSessionInput,
    candidates: ExtractionCandidate[],
    known: KnownMemoryIndex,
  ): Promise<void> {
    const userId = input.userId!;
    let activeCount = await this.memoryRepo.countActive(userId);
    if (activeCount >= MEMORY_ACTIVE_LIMIT) {
      console.warn(`[memory-extraction] active memory limit (${MEMORY_ACTIVE_LIMIT}) reached, evicting stale AUTO rows for userId=${userId}`);
    }
    let evicted = 0;
    for (const candidate of candidates) {
      let scope = candidate.scope;
      let projectKey = '';
      if (scope === 'PROJECT') {
        if (hasText(input.projectKey) && !isRobotChannelProjectKey(input.projectKey, input.workspace)) {
          projectKey = input.projectKey!.trim();
        } else {
          // 会话无有效 projectKey（为空或机器人渠道特殊值）时降级为 USER 级
          scope = 'USER';
        }
      }

      if (candidate.action !== 'insert') {
        await this.applySemanticAction(userId, candidate, scope, projectKey, known);
        continue;
      }

      const dedupHash = computeDedupHash(scope, projectKey, candidate.content);
      const existing = await this.memoryRepo.findByHash(userId, dedupHash);
      if (existing == null) {
        if (activeCount >= MEMORY_ACTIVE_LIMIT) {
          // D14：满了不再整体放弃——按组淘汰最旧 AUTO 行（软降级可恢复）腾名额，一轮最多淘汰 3 条
          if (evicted >= MEMORY_EXTRACT_MAX_ITEMS) {
            console.warn(`[memory-extraction] eviction cap reached, skip insert sessionId=${input.sessionId}`);
            continue;
          }
          const slotFreed = await this.evictStale(userId, scope, projectKey);
          if (!slotFreed) {
            console.warn(`[memory-extraction] no evictable AUTO row in group scope=${scope} projectKey=${projectKey}, skip insert userId=${userId}`);
            continue;
          }
          evicted += 1;
          activeCount -= 1;
        }
        try {
          await this.memoryRepo.insert({
            userId,
            scope,
            projectKey,
            content: candidate.content,
            source: 'AUTO',
            status: 'ACTIVE',
            dedupHash,
            originSessionId: input.sessionId,
          });
          activeCount += 1;
        } catch (e) {
          if (!isDuplicateKeyError(e)) throw e;
          // 并发插入撞唯一键：转为命中分支处理
          await this.applyDedupHit(userId, dedupHash);
        }
        continue;
      }
      await this.applyDedupHit(userId, dedupHash);
    }
  }

  /** D13 touch/update 执行：非法引用整条丢弃；update 哈希冲突回退 touch。 */
  private async applySemanticAction(
    userId: number,
    candidate: ExtractionCandidate,
    scope: MemoryScope,
    projectKey: string,
    known: KnownMemoryIndex,
  ): Promise<void> {
    const row = this.resolveKnownReference(known, candidate.existingId!, scope, projectKey);
    if (row == null) {
      console.warn(`[memory-extraction] illegal existingId=${candidate.existingId} for scope=${scope}, drop candidate`);
      return;
    }
    if (candidate.action === 'touch') {
      await this.memoryRepo.touch(row.id!);
      return;
    }
    const dedupHash = computeDedupHash(scope, projectKey, candidate.content);
    const conflicting = await this.memoryRepo.findByHash(userId, dedupHash);
    if (conflicting != null && conflicting.id !== row.id) {
      // 新表述与另一行逐字节相同：保留冲突行不动，仅再确认本行
      await this.memoryRepo.touch(row.id!);
      return;
    }
    try {
      await this.memoryRepo.updateContent(row.id!, candidate.content, dedupHash);
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
      await this.memoryRepo.touch(row.id!);
    }
  }

  /** D14 溢出淘汰：受影响组内 updated_at 最旧的一条 AUTO 行置 DISMISSED（软降级，可恢复）。 */
  private async evictStale(userId: number, scope: MemoryScope, projectKey: string): Promise<boolean> {
    const rows = await this.memoryRepo.listStaleAuto(userId, scope, projectKey, 1);
    const row = rows[0];
    if (row?.id == null) return false;
    await this.memoryRepo.updateStatus(row.id, 'DISMISSED');
    console.warn(`[memory-extraction] overflow evict: dismissed AUTO memory id=${row.id} scope=${scope} projectKey=${projectKey} userId=${userId}`);
    return true;
  }

  /** 命中已有行：ACTIVE 仅刷新 updated_at 视为再次确认；DISMISSED 跳过不复活（D3）。 */
  private async applyDedupHit(userId: number, dedupHash: string): Promise<void> {
    const row = await this.memoryRepo.findByHash(userId, dedupHash);
    if (row == null) return;
    if (row.status === 'DISMISSED') return;
    await this.memoryRepo.touch(row.id!);
  }

  private async resolveExtractionModel(): Promise<LlmModel | null> {
    const configured = await this.settingLookup.getValue(MEMORY_EXTRACTION_MODEL_ID_KEY);
    if (hasText(configured)) {
      const parsed = Number(configured!.trim());
      if (Number.isSafeInteger(parsed)) {
        const model = await this.modelLookup.selectById(parsed);
        if (model) return model;
        console.warn(`[memory-extraction] configured model ${configured} not found, fallback to default`);
      } else {
        console.warn(`[memory-extraction] invalid model config: ${configured}, fallback to default`);
      }
    }
    return this.modelLookup.selectDefault();
  }

  private async invoke(
    userText: string,
    assistantText: string,
    model: LlmModel,
    input: ExtractionSessionInput,
    knownRows: MemoryItemRow[],
    dismissedHints: string[],
  ): Promise<string> {
    const cancelFlag = new AtomicBoolean(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelFlag.set(true);
        reject(new Error('timeout'));
      }, EXTRACTION_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        LlmCallContext.runAsync({
          scene: LLM_CALL_SCENES.MEMORY_EXTRACT,
          userId: input.userId ?? null,
          sessionId: input.sessionId,
          agentId: input.agentId ?? null,
        }, async () => this.llmAdapter.chat({
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: buildExtractionUserPrompt(userText, assistantText, knownRows, dismissedHints) },
          ],
          tools: [],
          stream: false,
          temperature: 0.2,
          reasoning: { effort: 'none' },
          thinking: { type: 'disabled' },
          enableThinking: false,
        }, llmModelToConfig(model), cancelFlag)),
        timeout,
      ]);
      return responseText(response);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 输出解析：非法 JSON 返回 ok=false；容忍模型偶发的代码块围栏。count 为原始数组长度（>3 整体放弃的口径）。 */
export function parseExtractionOutput(raw: string): { ok: boolean; count: number; items: RawExtractionItem[] } {
  const text = stripCodeFence(raw.trim());
  if (text === '') return { ok: false, count: 0, items: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, count: 0, items: [] };
  }
  if (!Array.isArray(parsed)) return { ok: false, count: 0, items: [] };
  return {
    ok: true,
    count: parsed.length,
    items: parsed.filter((item): item is RawExtractionItem => item != null && typeof item === 'object' && !Array.isArray(item)),
  };
}

/**
 * 单条校验（D13 动作协议）：type 非法 / 内容为空 / 规范化超 120 字仅丢弃该条。
 * action 缺失或非法时按 insert 处理（向后兼容旧协议）；touch 不需要 content；
 * touch/update 缺合法 existingId 时整条丢弃（引用合法性在落库层按组二次校验）。
 */
export function toCandidate(item: RawExtractionItem): ExtractionCandidate | null {
  const type = typeof item.type === 'string' ? item.type.trim().toLowerCase() : '';
  if (type !== 'user' && type !== 'project') return null;
  const scope: MemoryScope = type === 'project' ? 'PROJECT' : 'USER';
  const action = typeof item.action === 'string' ? item.action.trim().toLowerCase() : '';
  const rawId = typeof item.existingId === 'number'
    ? item.existingId
    : typeof item.existingId === 'string' && item.existingId.trim() !== ''
      ? Number(item.existingId.trim())
      : NaN;
  const existingId = Number.isSafeInteger(rawId) && rawId > 0 ? rawId : null;
  if (action === 'touch') {
    // 再确认不需要 content；缺合法 existingId 时整条丢弃
    return existingId == null ? null : { scope, content: '', action: 'touch', existingId };
  }
  const content = normalizeMemoryContent(typeof item.content === 'string' ? item.content : '');
  if (!hasText(content)) return null;
  if (memoryContentLength(content) > MEMORY_EXTRACT_CONTENT_MAX_LENGTH) return null;
  if (action === 'update') {
    return existingId == null ? null : { scope, content, action: 'update', existingId };
  }
  // insert / action 缺失或非法：向后兼容旧协议
  return { scope, content, action: 'insert', existingId: null };
}

/** D13：user turn 组装——对话原文 + 已知记忆比较集 + 已忽略负面约束集（空段整体省略）。 */
function buildExtractionUserPrompt(
  userText: string,
  assistantText: string,
  knownRows: MemoryItemRow[],
  dismissedHints: string[],
): string {
  let sb = `<user_message>\n${truncateInput(userText)}\n</user_message>\n<assistant_reply>\n${truncateInput(assistantText)}\n</assistant_reply>`;
  const userRows = knownRows.filter((row) => (row.scope === 'PROJECT' ? 'PROJECT' : 'USER') === 'USER');
  const projectKeys = [...new Set(knownRows
    .filter((row) => row.scope === 'PROJECT')
    .map((row) => (row.projectKey != null && row.projectKey !== '' ? row.projectKey : '')))].sort();
  if (userRows.length > 0 || projectKeys.length > 0) {
    sb += '\n\n<known_memories>';
    if (userRows.length > 0) {
      sb += '\n[用户级]';
      for (const row of userRows) sb += `\n- id:${row.id} ${row.content}`;
    }
    for (const key of projectKeys) {
      sb += `\n[项目级:${key}]`;
      for (const row of knownRows) {
        if (row.scope === 'PROJECT' && (row.projectKey != null && row.projectKey !== '' ? row.projectKey : '') === key) {
          sb += `\n- id:${row.id} ${row.content}`;
        }
      }
    }
    sb += '\n</known_memories>';
  }
  if (dismissedHints.length > 0) {
    sb += '\n\n<ignored_memories>';
    for (const hint of dismissedHints) sb += `\n- ${hint}`;
    sb += '\n</ignored_memories>';
  }
  return sb;
}

function truncateInput(text: string): string {
  return text.length > MEMORY_EXTRACT_INPUT_MAX_CHARS ? text.slice(0, MEMORY_EXTRACT_INPUT_MAX_CHARS) : text;
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  return fenced ? fenced[1].trim() : text;
}

/** DB 存储的消息正文：纯文本或 JSON 数组（多模态分片），只取文本部分。 */
export function extractStoredText(content: string | null | undefined): string {
  if (content == null) return '';
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((part): part is Record<string, unknown> => part != null && typeof part === 'object')
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n')
          .trim();
      }
    } catch {
      // 非 JSON 数组，按原文处理
    }
  }
  return trimmed;
}

function responseText(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}
