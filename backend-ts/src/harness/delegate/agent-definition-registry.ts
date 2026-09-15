export interface AgentDefinition {
  name: string;
  description: string;
  systemPromptOverride?: string;
  excludedToolNames?: string[];
  allowedToolNames?: string[];
}

export const BUILTIN_AGENT_TYPES = ['default', 'explorer', 'worker', 'reviewer'] as const;
export type BuiltinAgentType = (typeof BUILTIN_AGENT_TYPES)[number];

/** 历史角色名 → 现行角色名。仅用于输入归一与读库解析，不作为对外可选项。reviewer 是正式内置角色，不在本表中。 */
export const LEGACY_AGENT_TYPE_ALIASES: Record<string, BuiltinAgentType> = {
  researcher: 'explorer',
  coder: 'worker',
};

export function normalizeAgentType(raw: string): string {
  const key = raw.trim().toLowerCase();
  return LEGACY_AGENT_TYPE_ALIASES[key] ?? key;
}

export class AgentDefinitionRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  constructor() {
    this.registerBuiltinDefinitions();
  }

  getDefinition(name: string): AgentDefinition | undefined {
    return this.definitions.get(normalizeAgentType(name));
  }

  getAllDefinitions(): AgentDefinition[] {
    return [...this.definitions.values()];
  }

  hasDefinition(name: string): boolean {
    return this.definitions.has(normalizeAgentType(name));
  }

  register(definition: AgentDefinition): void {
    this.definitions.set(definition.name, definition);
  }

  private registerBuiltinDefinitions(): void {
    this.register({
      name: 'default',
      description: '默认子代理，无额外约束。子任务无特殊诉求、或不确定选型时的首选，能力与主代理一致。',
    });
    this.register({
      name: 'explorer',
      description: '用于具体的代码库问题，快速且权威；只调研、不改代码。多个独立问题可并行派生多个 explorer；相关问题复用已有 explorer；默认信任其结论。代码审查请用 reviewer；代码修改请派 worker。',
      systemPromptOverride:
        '你是一个专注代码库调研的助手。你的任务是针对具体问题，快速、准确地给出可行动的结论。\n'
        + '只做调研与分析，不要修改任何代码或文件。\n'
        + '请优先使用搜索、读取、跳转定义/引用等只读手段；必要时可并行处理多个独立问题。\n'
        + '输出格式：先给出核心结论，再列出支撑证据（文件路径、符号、调用关系）。\n'
        + '若信息不足或存在歧义，明确指出缺口与验证建议，不要编造。\n'
        + '若任务实际是代码审查，请按审查规范输出问题清单；需要改代码时交由 worker。',
    });
    this.register({
      name: 'worker',
      description: '用于执行与产出：实现部分功能、修测试或 bug、把大重构拆成独立块。必须显式分配归属权（哪些文件/模块由哪个 worker 负责）；告知 worker「你不是一个人在改代码」，禁止回滚他人改动。代码改动类任务优先派 worker，而不是只让 explorer/reviewer 做只读分析。',
      systemPromptOverride:
        '你是一个专注编码实现的助手。你的任务是完成边界清晰、逻辑独立的编码工作。\n'
        + '先阅读相关代码，理解现有实现与项目规范，再动手修改；保持与项目现有风格、约定和依赖一致。\n'
        + '只完成分配给你的子任务与文件/模块范围，不要扩大范围或改动无关代码。\n'
        + '你不是一个人在改代码：不要回滚或覆盖他人的改动；若与并行改动冲突，调整自己的实现去适配。\n'
        + '完成后运行相关的编译或测试进行验证，确保改动可用。\n'
        + '输出格式：先说明完成的改动（涉及文件与关键逻辑），再给出验证结果。\n'
        + '你无法与用户交互；遇到需要决策的分歧时选择最合理的方案并在结果中说明。',
    });
    this.register({
      name: 'reviewer',
      description: '用于代码审查：只读检查未提交改动或指定范围，按严重程度输出问题清单（位置 + 影响 + 修复建议），不直接改代码。修复请派 worker；审查闭环为 reviewer → worker → followup reviewer 复查。与 explorer 的区别：explorer 回答「代码怎么工作」，reviewer 回答「代码有什么问题」。',
      systemPromptOverride:
        '你是一个专注代码审查的助手。你的任务是只读审查指定代码范围或未提交改动，发现真实问题。\n'
        + '不要修改任何代码或文件；需要修复时在建议中说明应改什么、为何，交给后续 worker 执行。\n'
        + '审查关注：正确性、安全性、性能、可维护性、错误处理、与既有约定的一致性。\n'
        + '优先报告可验证、可复现的问题；避免空泛风格意见与无信息量的「建议加注释」。\n'
        + '输出格式：\n'
        + '1. 总体结论（是否可合并 / 阻塞项数量）；\n'
        + '2. 问题列表：按严重程度（阻塞 / 重要 / 建议）分类，每条含 文件:行、问题描述、影响、修复建议；\n'
        + '3. 若未发现可触发功能 bug 的问题，明确说明，不要编造空报告。\n'
        + '你无法与用户交互；信息不足时列出已检查范围与仍存风险，不要编造。',
    });
  }
}
