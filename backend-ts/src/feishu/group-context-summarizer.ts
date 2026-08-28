import type { LlmChatClient, LlmChatRequest, LlmModelConfig } from '../model/types.js';

const SYSTEM_PROMPT = `你是群聊记录摘要助手。把群聊记录压缩为一份简明摘要，供 AI 助手在后续对话中了解此前的讨论背景。
要求：
- 保留：讨论主题、达成的结论与决定、关键事实（数字、链接、文件、时间、人名）、未解决的问题与待办；
- 忽略：寒暄、表情、纯闲聊、重复内容；
- 按主题分点陈述，每点一行，使用与记录一致的语言（默认简体中文）；
- 总长度不超过 300 字；
- 只输出摘要正文，不要标题、前缀、结尾说明或解释。`;

export class GroupContextSummarizer {
  constructor(
    private readonly llmClient: LlmChatClient,
    private readonly resolveModelConfig: (sessionId: number) => Promise<LlmModelConfig | null>,
  ) {}

  /** 对溢出群消息文本（调用方已按注入格式渲染）生成摘要；模型不可用或调用失败时返回 null（不阻塞主流程）。 */
  async summarize(record: string, sessionId: number): Promise<string | null> {
    if (record.trim() === '') return null;
    try {
      const config = await this.resolveModelConfig(sessionId);
      if (config == null) return null;
      const request: LlmChatRequest = {
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: record },
        ],
        temperature: 0.2,
        stream: false,
      };
      const response = await this.llmClient.chat(request, config);
      const text = extractText(response);
      return text !== '' ? text : null;
    } catch (error) {
      console.warn(`群聊溢出消息摘要失败: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

function extractText(response: unknown): string {
  const choices = (response as { choices?: Array<{ message?: { content?: unknown } | null }> })?.choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part != null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
}
