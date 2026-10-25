import { describe, expect, it } from 'vitest';
import { AGENT_TEMPLATES } from './agent-templates.js';

describe('AGENT_TEMPLATES', () => {
  it('至少提供一个模板，字段完整且 slug 唯一', () => {
    expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(1);
    const slugs = AGENT_TEMPLATES.map((tpl) => tpl.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const tpl of AGENT_TEMPLATES) {
      expect(tpl.name.trim()).not.toBe('');
      expect(tpl.description.trim()).not.toBe('');
      expect(tpl.systemPrompt.trim().length).toBeGreaterThan(20);
    }
  });

  it('模板零外部依赖：不引用技能 / MCP（提示词只依赖内置联网工具）', () => {
    for (const tpl of AGENT_TEMPLATES) {
      expect(tpl.systemPrompt).not.toMatch(/skill|技能|mcp/i);
    }
  });

  it('推荐问题非空且带来源要求，支撑首次任务即看到引用溯源', () => {
    for (const tpl of AGENT_TEMPLATES) {
      expect(tpl.suggestedQuestions.length).toBeGreaterThan(0);
      expect(tpl.suggestedQuestions.every((q) => q.trim().length > 0)).toBe(true);
    }
    expect(AGENT_TEMPLATES[0].systemPrompt).toContain('来源');
  });
});
