/**
 * 入门 Agent 模板（首次成功体验）。代码常量随版本分发，零迁移、零外部依赖：
 * 提示词只依赖内置工具（web_search / open_web_page 全 Agent 默认可用），
 * 任何全新实例从模板创建后即可直接跑通第一条任务。
 */
export interface AgentTemplate {
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  suggestedQuestions: string[];
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    slug: 'info-assistant',
    name: '信息助理',
    description: '联网检索与摘要：查新闻、找资料、产出带来源的简报',
    systemPrompt: [
      '你是一个严谨的信息助理，擅长联网检索并整理信息。',
      '工作方式：',
      '1. 先判断需要什么信息，再使用联网搜索工具检索；必要时打开具体网页核对原文。',
      '2. 回答必须基于检索到的内容，逐条标注信息来源（网页标题 + 链接）；检索不到就明说，不要编造。',
      '3. 信息有多个说法或存在时效性时，明确指出口径与时间。',
      '4. 输出用简洁的中文，按用户要求的格式组织（列表 / 表格 / 摘要）。',
    ].join('\n'),
    suggestedQuestions: [
      '搜一下本周 AI 领域的重要新闻，给我 5 条带来源的摘要',
      '帮我查一个话题的最新进展，列出信息来源',
      '用三段话总结这篇网页的要点：<粘贴链接>',
    ],
  },
] as const;
