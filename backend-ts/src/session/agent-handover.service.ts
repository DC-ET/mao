import type { LlmModel } from '../domain/types.js';
import type { Session } from './types.js';
import { AtomicBoolean } from '../harness/atomic-boolean.js';
import { hasText } from '../common/case.js';
import { llmModelToConfig } from '../harness/deps.js';
import type { ChatResponse, LlmAdapter } from '../harness/llm/chat-request.js';
import type { MessageRepository } from './session.repository.js';
import { isRealUserMessage } from '../harness/core/compaction-service.js';
import { SESSION_TITLE_MODEL_ID_KEY } from '../settings/settings.service.js';
import { LLM_CALL_SCENES, LlmCallContext } from '../usage/llm-call-context.js';

const HANDOVER_TIMEOUT_MS = 30_000;
/** 参与摘要的最近消息条数上限（技术方案 2026-10-29 §4.3-2）。 */
const HANDOVER_MAX_MESSAGES = 40;
/** 单条消息进入提示词的最大长度，防止个别超长消息吃掉全部输入预算。 */
const HANDOVER_MESSAGE_CLIP = 1500;

const SYSTEM_PROMPT = `你是会话接手说明生成器。根据会话最近的消息记录，为接下来接手该任务的助手写一段交接说明。
要求：
1. 全文不超过 300 字；
2. 依次覆盖三方面：任务背景、已确认的结论与产物、未完成事项；
3. 只依据消息中真实出现的内容，不编造、不推测；
4. 跟随会话消息的主要语言；
5. 只输出说明正文，不要标题、引号、Markdown 或解释。`;

/** 接手说明生成的模型解析依赖（与标题生成同链：配置的标题模型优先，缺省回全局默认）。 */
export interface HandoverModelLookup {
  selectById(id: number): Promise<LlmModel | null>;
  selectDefault(): Promise<LlmModel | null>;
}

export interface HandoverSettingLookup {
  getValue(key: string): Promise<string | null>;
}

/**
 * 「用其他 Agent 重开」的接手说明起草（技术方案 2026-10-29 §4.3）。
 * 结构镜像 session-title.service.ts：取最近消息 → 组提示词 → 30s 超时 →
 * 异常吞掉返回 null，不阻塞重开主流程（失败时客户端预填空输入）。
 */
export class AgentHandoverService {
  constructor(
    private readonly messageRepo: Pick<MessageRepository, 'listBySession'>,
    private readonly llmAdapter: LlmAdapter,
    private readonly modelLookup: HandoverModelLookup,
    private readonly settingLookup: HandoverSettingLookup,
  ) {}

  async generateHandoverNote(session: Session): Promise<string | null> {
    const sessionId = session.id;
    if (sessionId == null) return null;
    try {
      const transcript = await this.collectTranscript(sessionId);
      if (transcript.length === 0) return null;
      const model = await this.resolveHandoverModel();
      if (model == null) return null;
      const note = await this.invoke(session, transcript, model);
      return note;
    } catch (error) {
      console.warn(`[agent-handover] failed sessionId=${sessionId}: ${errorMessage(error)}`);
      return null;
    }
  }

  /**
   * 最近消息转录：自尾向前扫描，过滤压缩摘要 / `<system-notice>` 注入 / 空行
   * （isRealUserMessage 同口径，技术方案 D5），保留真实用户消息与助手回复，凑满即停。
   * 库内 role 为大写枚举（V001：USER / ASSISTANT / SYSTEM / TOOL），统一小写比较。
   */
  private async collectTranscript(sessionId: number): Promise<ChatMessage[]> {
    const all = await this.messageRepo.listBySession(sessionId);
    const picked: ChatMessage[] = [];
    for (let i = all.length - 1; i >= 0 && picked.length < HANDOVER_MAX_MESSAGES; i--) {
      const row = all[i]!;
      const text = messageText(row.content);
      if (text === '') continue;
      const role = (row.role ?? '').toLowerCase();
      if (role === 'user') {
        // 压缩摘要模板与系统注入都以 user role 落库，按真实用户消息口径排除
        if (!isRealUserMessage({ role: 'user', content: row.content ?? '' })) continue;
        picked.unshift({ role: 'user', content: clip(text) });
      } else if (role === 'assistant') {
        picked.unshift({ role: 'assistant', content: clip(text) });
      }
    }
    return picked;
  }

  private async resolveHandoverModel(): Promise<LlmModel | null> {
    const configured = await this.settingLookup.getValue(SESSION_TITLE_MODEL_ID_KEY);
    if (hasText(configured)) {
      const parsed = Number(configured!.trim());
      if (Number.isSafeInteger(parsed)) {
        const model = await this.modelLookup.selectById(parsed);
        if (model) return model;
        console.warn(`[agent-handover] configured title model ${configured} not found, fallback to default`);
      } else {
        console.warn(`[agent-handover] invalid title model config: ${configured}, fallback to default`);
      }
    }
    return this.modelLookup.selectDefault();
  }

  private async invoke(session: Session, transcript: ChatMessage[], model: LlmModel): Promise<string | null> {
    const cancelFlag = new AtomicBoolean(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelFlag.set(true);
        reject(new Error('timeout'));
      }, HANDOVER_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        LlmCallContext.runAsync({
          scene: LLM_CALL_SCENES.AGENT_HANDOVER_SUMMARY,
          userId: session.userId ?? null,
          sessionId: session.id ?? null,
          agentId: session.agentId ?? null,
        }, async () => this.llmAdapter.chat({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: transcriptToPrompt(transcript) },
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
      const note = responseText(response).trim();
      return note !== '' ? note : null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

interface ChatMessage {
  role: string;
  content: string;
}

function clip(text: string): string {
  return text.length > HANDOVER_MESSAGE_CLIP ? `${text.slice(0, HANDOVER_MESSAGE_CLIP)}…` : text;
}

function transcriptToPrompt(transcript: ChatMessage[]): string {
  const lines = transcript.map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`);
  return `以下是该会话最近的消息记录：\n\n${lines.join('\n\n')}`;
}

/** 消息行文本抽取：图片等多 part 内容在库中以 JSON 数组字符串存储，只取文本 part。 */
function messageText(content: string | null | undefined): string {
  const raw = (content ?? '').trim();
  if (raw === '' || !raw.startsWith('[')) return raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return raw;
    return parsed
      .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
      .filter((item) => item.type === 'text' && typeof item.text === 'string')
      .map((item) => String(item.text))
      .join(' ')
      .trim();
  } catch {
    return raw;
  }
}

function responseText(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
