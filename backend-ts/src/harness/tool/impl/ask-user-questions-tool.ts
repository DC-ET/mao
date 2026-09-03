import { BaseTool } from '../tool.js';

export class AskUserQuestionsTool extends BaseTool {
  getName(): string { return 'ask_user_questions'; }

  getDescription(): string {
    return `在执行过程中需要向用户提问时使用本工具。可用于：
- 收集用户偏好或需求
- 澄清含糊不清的指令
- 在推进工作的同时就实现方案征求决策
- 向用户提供可选方向供其选择
使用说明：
- 用户始终可以选择「其他」并填写自定义文本
- 将 multiSelect 设为 true，可允许同一问题多选
- 若推荐某一选项，请将其置于选项列表首位，并在 label 末尾加上「（推荐）」`;
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          description: '包含 1–4 个问题对象的数组。必须是 JSON 数组本身，严禁序列化为字符串或双重编码',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            required: ['question', 'header', 'options', 'multiSelect'],
            properties: {
              question: { type: 'string', description: '完整的问题文本，以问号结尾' },
              header: { type: 'string', maxLength: 12, description: '极短标签，以芯片/标签形式展示' },
              options: {
                type: 'array',
                description: '包含 2–4 个选项对象',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  required: ['label', 'description'],
                  properties: {
                    label: { type: 'string', description: '展示文案，1–5 个词' },
                    description: { type: 'string', description: '该选项含义的说明' },
                  },
                },
              },
              multiSelect: { type: 'boolean', description: '为 true 时允许多选' },
            },
          },
        },
        metadata: { type: 'object', description: '可选的追踪元数据' },
      },
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        answers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              selectedLabels: { type: 'array', items: { type: 'string' } },
              customInput: { type: 'string' },
            },
          },
        },
      },
    };
  }

  protected executeWithSession(_argumentsJson: string, _sessionId: number | null, _workspace: string | null): string {
    return '{"error": "ask_user_questions must be dispatched to client, not executed on server"}';
  }
}
