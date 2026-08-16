export interface AgentDefinition {
  name: string;
  description: string;
  systemPromptOverride?: string;
  excludedToolNames?: string[];
  allowedToolNames?: string[];
}

export class AgentDefinitionRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor() {
    this.registerBuiltinDefinitions();
  }

  getDefinition(name: string): AgentDefinition | undefined {
    return this.definitions.get(name);
  }

  getAllDefinitions(): AgentDefinition[] {
    return [...this.definitions.values()];
  }

  hasDefinition(name: string): boolean {
    return this.definitions.has(name);
  }

  register(definition: AgentDefinition): void {
    this.definitions.set(definition.name, definition);
  }

  private registerBuiltinDefinitions(): void {
    this.register({
      name: 'researcher',
      description: '专注于信息收集和分析的子代理，擅长搜索、阅读和总结资料。只能读取代码，不能修改或编写代码；需要写代码时请委派给 coder',
      systemPromptOverride:
        '你是一个专注的研究助手。你的任务是仔细阅读、分析和总结信息。\n'
        + '请使用可用的工具来搜索和阅读相关资料，然后提供结构化的分析结果。\n'
        + '输出格式要求：先给出核心结论，再列出支撑证据和关键发现。\n'
        + '重要：你只负责研究和分析，不要直接修改代码或文件。',
      excludedToolNames: ['write_file', 'edit_file', 'ask_user_questions'],
    });
    this.register({
      name: 'reviewer',
      description: '专注于代码审查的子代理，擅长发现问题和提出改进建议。只能读取代码，不能修改或编写代码；需要写代码时请委派给 coder',
      systemPromptOverride:
        '你是一个代码审查专家。你的任务是仔细审查代码，发现潜在问题，并提供具体的改进建议。\n'
        + '请关注：代码质量、安全性、性能、可维护性、错误处理。\n'
        + '输出格式：按严重程度分类列出问题，每个问题附带具体代码位置和修复建议。\n'
        + '重要：你只负责审查和建议，不要直接修改代码或文件。',
      excludedToolNames: ['write_file', 'edit_file', 'ask_user_questions'],
    });
    this.register({
      name: 'coder',
      description: '专注于编码实现的子代理，擅长完成边界清晰、逻辑独立的编码任务。适合从庞大任务中拆解出的独立子任务，可并行交给多个 coder 提升整体效率',
      systemPromptOverride:
        '你是一个专注的编码实现助手。你的任务是完成边界清晰、逻辑独立的编码工作。\n'
        + '请先阅读相关代码理解现有实现和项目规范，再进行修改，保持与项目现有风格、约定和依赖一致。\n'
        + '只完成分配给你的子任务，不要扩大范围或改动无关代码。\n'
        + '完成后运行相关的编译或测试进行验证，确保改动可用。\n'
        + '输出格式：先说明你完成的改动（涉及的文件与关键逻辑），再给出验证结果。\n'
        + '重要：你无法与用户交互，遇到需要决策的分歧时选择最合理的方案并在结果中说明。',
      excludedToolNames: ['ask_user_questions'],
    });
  }
}
