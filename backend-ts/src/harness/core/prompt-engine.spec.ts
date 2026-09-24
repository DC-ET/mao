import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { WEIXIN_PROJECT_KEY } from '../../domain/types.js';
import { AgentExecutionContext } from './agent-execution-context.js';
import { PromptEngine } from './prompt-engine.js';
import { MISSING_TOOL_RESULT_PLACEHOLDER } from './message-history-normalizer.js';
import { SYNTHETIC_ATTACHMENT_PROMPT } from './tool-media-injector.js';
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
    const workspace = useTmpDir('pe-ws-');
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
    expect(system).toContain('default');
    expect(system).toContain('explorer');
    expect(system).toContain('reviewer');
    expect(system).toContain('worker');
    expect(system).toContain('子代理追问 / 纠偏');
    expect(system).toContain('rule-one');
    const user = request.messages[1].content as string;
    expect(user).toContain('/java');
    expect(user).toContain('please review');
    expect(user).toContain('src/App.ts');
  });

  it('feishuChannelTellsTheModelToWaitForTheCardForm', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.projectKey = 'feishu-2-private-9';
    context.executionMode = 'CLOUD';
    context.workspace = '/opt/mao-data/workspace/9/projects/feishu-2-private-9';
    context.tools = [tool('ask_user_questions'), tool('read_file')];
    const request = await engine.buildRequest(context);
    const system = request.messages[0].content as string;
    expect(system).toContain('用户在进度卡片的表单里提交');
    expect(system).toContain('不要在正文里再要求用户打字回复');
    expect(system).toContain('使用ask_user_questions工具');

    const group = new AgentExecutionContext();
    group.projectKey = 'oc_group';
    group.workspace = '/opt/mao-data/workspace/feishu-chat/2/oc_group';
    group.executionMode = 'CLOUD';
    group.tools = [tool('ask_user_questions')];
    const groupRequest = await engine.buildRequest(group);
    expect(groupRequest.messages[0].content).toContain('进度卡片的表单');

    const desktop = new AgentExecutionContext();
    desktop.projectKey = 'proj';
    desktop.workspace = '/ws';
    desktop.executionMode = 'CLOUD';
    desktop.tools = [tool('ask_user_questions')];
    const desktopRequest = await engine.buildRequest(desktop);
    expect(desktopRequest.messages[0].content).not.toContain('进度卡片的表单');
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

  it('injects embed channel base and skips coding workspace when page tools exist', async () => {
    const workspace = useTmpDir('pe-embed-');
    writeFileSync(join(workspace, 'AGENTS.md'), '# agents\nshould-not-appear\n');
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => workspace } as never,
      RuntimeDataResolver.forTest(join(workspace, 'runtime'), join(workspace, 'home')),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 3;
    context.sessionId = 8;
    context.systemPrompt = '你是服务治理页的网页助手';
    context.experiences = ['金额以页面为准'];
    context.executionMode = 'CLOUD';
    context.workspace = workspace;
    context.isGit = true;
    context.currentTimestamp = '2026-09-10';
    context.tools = [tool('page_screenshot'), tool('page_inspect'), tool('read_file')];
    const request = await engine.buildRequest(context);
    const system = request.messages[0].content as string;
    expect(system).toContain('你是服务治理页的网页助手');
    expect(system).toContain('金额以页面为准');
    expect(system).toContain('嵌入式对话浮窗');
    expect(system).toContain('页面上下文与可见范围');
    expect(system).toContain('自定义搜索下拉');
    expect(system).toContain('[页面上下文]');
    expect(system).toContain('[用户选中文本]');
    expect(system).toContain('attachment://');
    expect(system).toContain('不要在回复里用 Markdown 图片');
    expect(system).toContain('当前日期：`2026-09-10`');
    expect(system).not.toContain('你当前的工作目录是');
    expect(system).not.toContain('CLOUD 云端模式');
    expect(system).not.toContain('使用read_file而不是cat');
    expect(system).not.toContain('请使用 shell 执行 `date`');
    expect(system).not.toContain('用户上传的文件');
    // 浮窗只支持粘贴附件：仍需说明 @{绝对路径}@ 的读法，但不能灌编程助手的上传目录/工作区说明
    expect(system).toContain('用户可在输入框直接粘贴图片或文件');
    expect(system).not.toContain('上传目录：');
    expect(system).not.toContain('should-not-appear');
    expect(system).not.toContain('## 工作区规则');
  });

  it('keeps coding workspace guidance when page tools are absent', async () => {
    const workspace = useTmpDir('pe-code-');
    writeFileSync(join(workspace, 'AGENTS.md'), '# agents\nrule-coding\n');
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => workspace } as never,
      RuntimeDataResolver.forTest(join(workspace, 'runtime'), join(workspace, 'home')),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.executionMode = 'CLOUD';
    context.workspace = workspace;
    context.tools = [tool('read_file')];
    const request = await engine.buildRequest(context);
    const system = request.messages[0].content as string;
    expect(system).toContain('你当前的工作目录是');
    expect(system).toContain('使用read_file而不是cat');
    expect(system).toContain('rule-coding');
    expect(system).not.toContain('嵌入式对话浮窗');
    expect(system).not.toContain('页面上下文与可见范围');
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

  it('buildRequestFillsMissingToolOutputAndKeepsParallelToolGroupBeforeImage', async () => {
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.modelConfig = { modelId: 'gpt-5', id: 1, apiProtocol: 'openai-responses', supportsVision: true };
    context.messages = [
      { role: 'user', content: '看图并读文件' },
      {
        role: 'assistant', content: '', toolCalls: [
          { id: 'call_01_ET_hVY3McifxdUHAsw5uQcI3406', type: 'function', function: { name: 'page_screenshot', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_01_ET_hVY3McifxdUHAsw5uQcI3406', content: 'shot' },
    ];
    context.toolAttachments.set('call_01_ET_hVY3McifxdUHAsw5uQcI3406', {
      mime: 'image/png', path: 'a.png', dataUri: 'data:image/png;base64,abc',
    });
    const request = await engine.buildRequest(context);
    const body = request.messages.slice(1);
    expect(body.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(body[2].toolCallId).toBe('call_01_ET_hVY3McifxdUHAsw5uQcI3406');
    expect(body[3].toolCallId).toBe('call_2');
    expect(body[3].content).toBe(MISSING_TOOL_RESULT_PLACEHOLDER);
    const parts = body[4].content as Array<{ type?: string; text?: string }>;
    expect(parts[0].text).toBe(SYNTHETIC_ATTACHMENT_PROMPT);
  });
});
void mkdirSync;
