import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { PromptEngine } from './prompt-engine.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import * as harnessLogModule from '../log.js';
import type { Tool } from '../tool/tool.js';

function tool(name: string): Tool {
  return {
    getName: () => name,
    getDescription: () => `${name} desc`,
    getInputSchema: () => ({ type: 'object' }),
    getOutputSchema: () => ({}),
    execute: () => '',
  };
}

describe('PromptEngine', () => {
  it('buildRequestExpandsMarkersAndAddsCloudPromptSkillsAndTools', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'pe-ws-'));
    writeFileSync(join(workspace, 'AGENTS.md'), '# agents\nrule-one\n');
    const skillLoader = {
      hasSkill: vi.fn((n: string) => n === 'java'),
      getAllNames: vi.fn(() => ['java']),
      getAllDocuments: vi.fn(() => [{ name: 'java', description: 'Java skill' }]),
    };
    const pathSandbox = { getWorkspaceRoot: () => workspace };
    const runtime = RuntimeDataResolver.forTest(join(workspace, 'runtime'), join(workspace, 'home'));
    const userCommandService = {
      getByUserIdAndName: vi.fn(async (_uid: number, name: string) => (
        name === 'review' ? { content: 'please review' } : null
      )),
    };
    const skillSync = {
      getUserSkillDocuments: vi.fn(() => [{ name: 'mine', description: 'user skill' }]),
    };
    const engine = new PromptEngine(
      skillLoader as never,
      pathSandbox as never,
      runtime,
      userCommandService as never,
      skillSync as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 7;
    context.sessionId = 9;
    context.systemPrompt = 'You are Mao';
    context.experiences = ['write tests'];
    context.workspace = workspace;
    context.executionMode = 'CLOUD';
    context.isGit = true;
    context.platform = 'darwin';
    context.shellPath = 'bash';
    context.osVersion = 'Darwin 24';
    context.currentTimestamp = '2026-08-13';
    context.availableSkillNames = ['java', 'mine'];
    context.availableSkillDocs.set('java', { name: 'java', description: 'Java skill' });
    context.availableSkillDocs.set('mine', { name: 'mine', description: 'user skill' });
    context.tools = [tool('read_file'), tool('task_create'), tool('spawn_subagent'), tool('subagent_followup')];
    context.modelConfig = { modelId: 'gpt-5', id: 1, apiProtocol: 'openai-responses', effort: 'high' };
    context.messages = [
      { role: 'user', content: 'use ${java}$ and #{review}# and @{src/App.ts}@' },
    ];

    const request = await engine.buildRequest(context);
    expect(request.stream).toBe(true);
    expect(request.reasoning).toEqual({ effort: 'high' });
    expect(request.promptCacheKey).toBe('mao-session-9');
    expect(request.tools?.map((t) => t.function.name)).toEqual(
      expect.arrayContaining(['read_file', 'task_create', 'spawn_subagent', 'subagent_followup']),
    );
    const system = request.messages[0].content as string;
    expect(system).toContain('You are Mao');
    expect(system).toContain('最佳实践经验');
    expect(system).toContain('write tests');
    expect(system).toContain('CLOUD 云端模式');
    expect(system).toContain('可用技能');
    expect(system).toContain('**java**');
    expect(system).toContain('任务管理');
    expect(system).toContain('子代理委派');
    expect(system).toContain('子代理追问 / 纠偏');
    expect(system).toContain('rule-one');
    const user = request.messages[1].content as string;
    expect(user).toContain('/java');
    expect(user).toContain('please review');
    expect(user).toContain('src/App.ts');
  });

  it('weixinChannelAddsDefaultExperiencesAndMediaHints', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.projectKey = WEIXIN_PROJECT_KEY;
    context.executionMode = 'LOCAL';
    context.workspace = '/Users/me/proj';
    context.tools = [tool('send_wechat_image')];
    context.localUnsyncedSkills = [{ name: 'local', folderName: 'local', description: 'd' }];
    context.availableSkillNames = ['local'];
    context.sessionId = 1;
    const request = await engine.buildRequest(context);
    const system = request.messages[0].content as string;
    expect(system).toContain('AGENTS.md');
    expect(system).toContain('LOCAL 本地模式');
    expect(system).toContain('微信媒体发送');
    expect(system).toContain('本地未同步');
  });

  it('adds embed screenshot display hints when page_screenshot is available', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.executionMode = 'CLOUD';
    context.workspace = '/ws';
    context.tools = [tool('page_screenshot'), tool('page_inspect')];
    const request = await engine.buildRequest(context);
    const system = request.messages[0].content as string;
    expect(system).toContain('页面截图展示');
    expect(system).toContain('attachment://');
    expect(system).toContain('不要在回复里用 Markdown 图片');
  });

  it('keepsUnknownSkillAndCommandMarkers', async () => {
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 1;
    context.messages = [{ role: 'user', content: '${missing}$ ${label}$ #{nope}#' }];
    const request = await engine.buildRequest(context);
    expect(request.messages[1].content).toBe('${missing}$ ${label}$ #{nope}#');
    expect(request.reasoning).toBeUndefined();
    expect(request.promptCacheKey).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith('warn', 'Skill not found for marker: ${missing}$');
    expect(logSpy).not.toHaveBeenCalledWith('warn', 'Skill not found for marker: ${label}$');
    expect(logSpy).toHaveBeenCalledWith('warn', 'Command not found for marker: #{nope}#');
    logSpy.mockRestore();
  });

  it('buildRequestInjectsSessionScopedPromptCacheKey', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 1;
    context.sessionId = 42;
    context.modelConfig = { modelId: 'gpt-5.6-terra', id: 1 };
    context.messages = [{ role: 'user', content: 'hi' }];
    const request = await engine.buildRequest(context);
    expect(request.promptCacheKey).toBe('mao-session-42');
  });

  it('reasoningEffortFollowsProtocolAndModelConfig', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const build = async (modelConfig: Record<string, unknown> | null) => {
      const context = new AgentExecutionContext();
      context.userId = 1;
      context.modelConfig = modelConfig as never;
      context.messages = [{ role: 'user', content: 'hi' }];
      return engine.buildRequest(context);
    };

    // Responses 协议 + 显式 effort
    const responses = await build({ modelId: 'gpt-5', apiProtocol: 'openai-responses', effort: 'medium' });
    expect(responses.reasoning).toEqual({ effort: 'medium' });

    // Responses 协议 + effort 留空 → 默认 high
    const responsesDefault = await build({ modelId: 'gpt-5', apiProtocol: 'openai-responses' });
    expect(responsesDefault.reasoning).toEqual({ effort: 'high' });

    // OpenAI 兼容（apiProtocol 为空串）+ 自定义 effort
    const compatible = await build({ modelId: 'my-model', apiProtocol: '', effort: 'low' });
    expect(compatible.reasoning).toEqual({ effort: 'low' });

    // Anthropic 协议 → 不设置 reasoning
    const anthropic = await build({ modelId: 'claude-x', apiProtocol: 'anthropic', effort: 'high' });
    expect(anthropic.reasoning).toBeUndefined();

    // modelConfig 缺失 → 不设置 reasoning（旧行为）
    const missing = await build(null);
    expect(missing.reasoning).toBeUndefined();
  });
});
void mkdirSync;
