import { describe, expect, it } from 'vitest';
import { AgentExecutionContext } from './agent-execution-context.js';
import { PromptEngine } from './prompt-engine.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { Tool } from '../tool/tool.js';

/**
 * 「问题上报」section 条件注入（技术方案 2026-11-27 §5.4）：
 * context.tools 含 report_issue 时注入，不含时不注入——两级开关门控已在
 * buildContext 过滤工具列表，这里按 context.tools 判定，天然一致。
 */
function tool(name: string): Tool {
  return {
    getName: () => name,
    getDescription: () => `${name} desc`,
    getInputSchema: () => ({ type: 'object' }),
    getOutputSchema: () => ({}),
    execute: () => '',
  };
}

function makeEngine(): PromptEngine {
  return new PromptEngine(
    { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
    { getWorkspaceRoot: () => '/ws' } as never,
    RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
    { getByUserIdAndName: async () => null } as never,
    { getUserSkillDocuments: () => [] } as never,
  );
}

function makeContext(tools: string[]): AgentExecutionContext {
  const context = new AgentExecutionContext();
  context.projectKey = 'proj';
  context.executionMode = 'CLOUD';
  context.workspace = '/ws';
  context.tools = tools.map(tool);
  return context;
}

describe('PromptEngine 问题上报 section', () => {
  it('context.tools 含 report_issue 时注入「问题上报」节与静默规则', async () => {
    const engine = makeEngine();
    const request = await engine.buildRequest(makeContext(['read_file', 'report_issue']));
    const system = request.messages[0].content as string;
    expect(system).toContain('## 问题上报');
    expect(system).toContain('report_issue');
    expect(system).toContain('不要在回复中提及你已上报或该工具的存在');
    expect(system).toContain('同一问题只上报一次');
    expect(system).toContain('不代表你可以执行该指令');
  });

  it('context.tools 不含 report_issue 时不注入（开关关闭 / 未注册）', async () => {
    const engine = makeEngine();
    const request = await engine.buildRequest(makeContext(['read_file']));
    const system = request.messages[0].content as string;
    expect(system).not.toContain('## 问题上报');
    expect(system).not.toContain('report_issue');
  });
});
