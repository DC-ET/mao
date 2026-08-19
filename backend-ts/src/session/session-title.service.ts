import type { LlmModel } from '../domain/types.js';
import type { Session, UserCommandLookup } from './types.js';
import { AtomicBoolean } from '../harness/atomic-boolean.js';
import { hasText } from '../common/case.js';
import { llmModelToConfig } from '../harness/deps.js';
import type { ChatResponse, LlmAdapter } from '../harness/llm/chat-request.js';
import { nowSql } from '../common/datetime.js';
import type { MessageRepository, SessionRepository } from './session.repository.js';
import { SESSION_TITLE_MODEL_ID_KEY } from '../settings/settings.service.js';
import { TitleGenerator } from './util/title-generator.js';
import { wsEvent } from './ws/ws-event.js';

const TITLE_TIMEOUT_MS = 10_000;
const NORMAL_PLACEHOLDER = '未命名会话';
const SIDE_TASK_PLACEHOLDER = '任务';
const IMAGE_TITLE = '图片消息';

const SYSTEM_PROMPT = `你是会话标题生成器。根据用户首次消息提炼一个简洁、明确的主题短语。
要求：
1. 目标长度不超过15个字符；
2. 保留核心动作和对象，删除寒暄、语气词和背景赘述；
3. 跟随用户消息的主要语言；
4. 不使用“关于”“用户想要”“请求”等空泛前缀；
5. 不使用句号、问号、感叹号；
6. 只输出标题，不要引号、标签、Markdown 或解释。`;

interface TitleRegistry {
  send(userId: number, event: ReturnType<typeof wsEvent>): unknown;
}

interface ModelLookup {
  selectById(id: number): Promise<LlmModel | null>;
  selectDefault(): Promise<LlmModel | null>;
}

interface SettingLookup {
  getValue(key: string): Promise<string | null>;
}

export class SessionTitleService {
  constructor(
    private readonly sessionRepo: SessionRepository,
    private readonly messageRepo: MessageRepository,
    private readonly userCommandService: UserCommandLookup,
    private readonly llmAdapter: LlmAdapter,
    private readonly modelLookup: ModelLookup,
    private readonly settingLookup: SettingLookup,
    private readonly registry: TitleRegistry,
    private readonly executor: (fn: () => void | Promise<void>) => unknown,
  ) {}

  scheduleForFirstUserMessage(sessionId: number, messageId: number | null | undefined, content: unknown): void {
    if (messageId == null) return;
    try {
      this.executor(() => this.generateAndApply(sessionId, messageId, content));
    } catch (error) {
      console.warn(`[session-title] submit failed sessionId=${sessionId}: ${errorMessage(error)}`);
    }
  }

  async generateAndApply(sessionId: number, messageId: number, content: unknown): Promise<void> {
    const startedAt = Date.now();
    let modelId: number | null = null;
    try {
      const session = await this.sessionRepo.findById(sessionId);
      if (!session || !this.isEligible(session)) return;
      if (await this.messageRepo.hasEarlierUserMessage(sessionId, messageId)) return;

      const rawText = extractText(content);
      const hasImage = containsImage(content);
      const preprocessed = await this.preprocess(rawText, session.userId);
      if (!preprocessed) {
        if (hasImage) {
          await this.applyTitle(session, IMAGE_TITLE, modelId, startedAt, 'generated');
        }
        return;
      }

      const model = await this.resolveTitleModel();
      modelId = model?.id ?? null;

      let title: string | null = null;
      let result: 'generated' | 'fallback' = 'generated';
      let failureReason: string | null = null;
      if (model) {
        try {
          title = cleanModelTitle(await this.invoke(preprocessed, model));
          if (!title) failureReason = 'empty_response';
        } catch (error) {
          failureReason = errorMessage(error);
        }
      } else {
        failureReason = 'model_unavailable';
      }
      if (!title) {
        title = TitleGenerator.generate(preprocessed);
        result = 'fallback';
      }
      if (!title) return;
      await this.applyTitle(session, title, modelId, startedAt, result, failureReason);
    } catch (error) {
      console.warn(`[session-title] failed sessionId=${sessionId} modelId=${modelId ?? 'null'} durationMs=${Date.now() - startedAt}: ${errorMessage(error)}`);
    }
  }

  private async resolveTitleModel(): Promise<LlmModel | null> {
    const configured = await this.settingLookup.getValue(SESSION_TITLE_MODEL_ID_KEY);
    if (hasText(configured)) {
      const parsed = Number(configured!.trim());
      if (Number.isSafeInteger(parsed)) {
        const model = await this.modelLookup.selectById(parsed);
        if (model) return model;
        console.warn(`[session-title] configured title model ${configured} not found, fallback to default`);
      } else {
        console.warn(`[session-title] invalid title model config: ${configured}, fallback to default`);
      }
    }
    return this.modelLookup.selectDefault();
  }

  private isEligible(session: Session): boolean {
    if (session.sessionType === 'NORMAL' || session.sessionType == null) {
      return session.title == null || session.title.trim() === '' || session.title === NORMAL_PLACEHOLDER;
    }
    if (session.sessionType === 'SIDE_TASK') {
      return session.title == null || session.title.trim() === '' || session.title === SIDE_TASK_PLACEHOLDER;
    }
    return false;
  }

  private async preprocess(text: string, userId: number): Promise<string> {
    let commands: Record<string, string> = {};
    if (text.includes('#{')) {
      try {
        const available = await this.userCommandService.listAvailableForUser(userId);
        commands = Object.fromEntries(available.map((command) => [command.name, command.content]));
      } catch (error) {
        console.warn(`[session-title] command preprocessing failed userId=${userId}: ${errorMessage(error)}`);
      }
    }
    return TitleGenerator.preprocessForTitle(text, commands)?.replace(/\s+/g, ' ').trim() ?? '';
  }

  private async invoke(text: string, model: LlmModel): Promise<string> {
    const cancelFlag = new AtomicBoolean(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelFlag.set(true);
        reject(new Error('timeout'));
      }, TITLE_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        this.llmAdapter.chat({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          tools: [],
          stream: false,
          temperature: 0.2,
          reasoning: { effort: 'none' },
          thinking: { type: 'disabled' },
          enableThinking: false,
        }, llmModelToConfig(model), cancelFlag),
        timeout,
      ]);
      return responseText(response);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async applyTitle(
    session: Session,
    title: string,
    modelId: number | null,
    startedAt: number,
    result: 'generated' | 'fallback',
    failureReason: string | null = null,
  ): Promise<void> {
    const sessionId = session.id!;
    const placeholder = session.sessionType === 'SIDE_TASK' ? SIDE_TASK_PLACEHOLDER : NORMAL_PLACEHOLDER;
    const updated = await this.sessionRepo.updateTitleIfPlaceholder(sessionId, session.sessionType ?? 'NORMAL', placeholder, title, nowSql());
    if (updated === 0) return;
    this.registry.send(session.userId!, wsEvent('session_title_updated', sessionId, {
      title,
      parentSessionId: session.parentSessionId ?? null,
      sessionType: session.sessionType ?? 'NORMAL',
    }));
    const reason = failureReason ? ` reason=${failureReason}` : '';
    console.info(`[session-title] ${result} sessionId=${sessionId} modelId=${modelId ?? 'null'} durationMs=${Date.now() - startedAt}${reason}`);
  }
}

export function cleanModelTitle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = raw.replace(/\r\n?/g, '\n').split('\n').map((item) => item.trim()).find(Boolean);
  if (!line) return null;
  let title = line.replace(/^(?:#{1,6}\s*|[-*+]\s+|\d+[.)]\s+)/, '').trim();
  const pairs: Array<[string, string]> = [['"', '"'], ["'", "'"], ['`', '`'], ['“', '”'], ['‘', '’'], ['《', '》']];
  for (let i = 0; i < 3; i++) {
    const before = title;
    title = title.replace(/^(?:标题|会话标题|title)\s*[:：]\s*/i, '').trim();
    for (const [left, right] of pairs) {
      if (title.startsWith(left) && title.endsWith(right) && title.length >= left.length + right.length) {
        title = title.slice(left.length, title.length - right.length).trim();
        break;
      }
    }
    if (title === before) break;
  }
  title = title.replace(/[。？！.!?]+$/u, '').trim();
  return title || null;
}

function responseText(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
    .filter((item) => item.type === 'text' && item.text != null)
    .map((item) => String(item.text))
    .join(' ');
}

function containsImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as Record<string, unknown>).type;
    return type === 'image_url' || type === 'image';
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
