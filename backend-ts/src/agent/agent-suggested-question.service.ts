import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type {
  AgentSuggestedQuestion,
  AgentSuggestedQuestionRepository,
  SuggestedQuestionInput,
} from './types.js';

export class AgentSuggestedQuestionService {
  static readonly MAX_CONTENT_LENGTH = 100;
  static readonly MAX_ITEMS = 5;

  constructor(private readonly questionRepo: AgentSuggestedQuestionRepository) {}

  listByAgentId(agentId: number): Promise<AgentSuggestedQuestion[]> {
    return this.questionRepo.listByAgentId(agentId);
  }

  async getQuestion(agentId: number, id: number): Promise<AgentSuggestedQuestion> {
    const question = await this.questionRepo.findById(id);
    if (!question || question.agentId !== agentId) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '推荐问题不存在');
    }
    return question;
  }

  deleteByAgentId(agentId: number): Promise<void> {
    return this.questionRepo.deleteByAgentId(agentId);
  }

  /**
   * 全量同步：带 id 且属于该 Agent → 更新；无 id → 新增；库中多余 → 删除。
   * items == null 时不改动。
   * 硬限制：最多 5 条；单条 content 1～100 字。
   */
  async syncSuggestedQuestions(
    agentId: number,
    items: SuggestedQuestionInput[] | null | undefined,
  ): Promise<void> {
    if (items == null) return;

    if (items.length > AgentSuggestedQuestionService.MAX_ITEMS) {
      throw new BusinessException(ErrorCode.AGENT_SUGGESTED_QUESTION_LIMIT_EXCEEDED);
    }

    const existing = await this.questionRepo.listByAgentId(agentId);
    const existingIds = new Set(existing.map((row) => row.id!));
    const keepIds = new Set<number>();

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = this.normalizeAndValidateContent(item.content);
      const sortOrder = item.sortOrder != null ? item.sortOrder : i;

      if (item.id != null && existingIds.has(item.id)) {
        const question = await this.questionRepo.findById(item.id);
        if (question) {
          question.content = content;
          question.sortOrder = sortOrder;
          await this.questionRepo.updateById(question);
        }
        keepIds.add(item.id);
      } else {
        const question: AgentSuggestedQuestion = { agentId, content, sortOrder };
        await this.questionRepo.insert(question);
        keepIds.add(question.id!);
      }
    }

    for (const question of existing) {
      if (!keepIds.has(question.id!)) {
        await this.questionRepo.deleteById(question.id!);
      }
    }
  }

  normalizeAndValidateContent(content: string | null | undefined): string {
    if (content == null) {
      throw new BusinessException(ErrorCode.AGENT_SUGGESTED_QUESTION_CONTENT_INVALID);
    }
    const trimmed = content.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > AgentSuggestedQuestionService.MAX_CONTENT_LENGTH
    ) {
      throw new BusinessException(ErrorCode.AGENT_SUGGESTED_QUESTION_CONTENT_INVALID);
    }
    return trimmed;
  }
}

export function suggestedQuestionInputOf(
  id: number | null | undefined,
  content: string | null | undefined,
  sortOrder: number | null | undefined,
): SuggestedQuestionInput {
  return { id, content, sortOrder };
}
