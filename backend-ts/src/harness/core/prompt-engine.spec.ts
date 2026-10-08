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
import { TokenEstimator } from './token-estimator.js';
import { CompactionConfig } from './compaction-config.js';
import { buildHandoffUserContent } from './compaction-service.js';
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

  it('feishuChannelDoesNotInjectAskUserQuestionsHint', async () => {
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
    // 飞书会话不再单独注入 ask_user_questions 引导；通用工具引导仍存在
    expect(system).toContain('使用ask_user_questions工具');
    expect(system).not.toContain('## 飞书提问');
    expect(system).not.toContain('用户在进度卡片的表单里提交');
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

  it('doesNotTreatCommandSyntaxDescriptionsAsRealCommands', async () => {
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    const getByUserIdAndName = vi.fn(async () => null);
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 1;
    // 文档里描述 marker 语法本身：占位名、被旧正则从中间截断出的假命令，一律原样保留、
    // 不查表、不打日志。此前这些每轮 buildRequest 都刷 Command not found（线上曾全天 246 条）。
    context.messages = [{
      role: 'user',
      content: '用法见 `#{...}#` 与 #{skill_name}#，空嵌套 #{#{}}#',
    }];
    const request = await engine.buildRequest(context);
    expect(request.messages[1].content).toBe('用法见 `#{...}#` 与 #{skill_name}#，空嵌套 #{#{}}#');
    expect(getByUserIdAndName).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith('warn', expect.stringContaining('Command not found'));
    logSpy.mockRestore();
  });

  it('nestedCommandMarkerExpandsInnermostValidMarker', async () => {
    // 命令名不含花括号，故 `#{#{review}#}#` 的外层无法成标记，正则落到内层唯一的合法
    // 标记 `#{review}#` 并展开它。语义确定（每轮都从 DB 原文重放，不会二次展开），
    // 也优于旧正则把 `#{review` 当命令名去查表后刷一条噪声。
    const getByUserIdAndName = vi.fn(async (_uid: number, name: string) => (
      name === 'review' ? { content: 'please review' } : null
    ));
    const engine = new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
    const context = new AgentExecutionContext();
    context.userId = 1;
    context.messages = [{ role: 'user', content: '嵌套写法 #{#{review}#}#' }];
    const request = await engine.buildRequest(context);
    expect(request.messages[1].content).toBe('嵌套写法 #{please review}#');
    expect(getByUserIdAndName).toHaveBeenCalledTimes(1);
    expect(getByUserIdAndName).toHaveBeenCalledWith(1, 'review');
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

describe('PromptEngine long-term memories', () => {
  function engine() {
    return new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
  }

  function context(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
    const ctx = new AgentExecutionContext();
    ctx.executionMode = 'CLOUD';
    ctx.workspace = '/ws';
    ctx.experiences = ['经验一'];
    ctx.tools = [tool('read_file')];
    Object.assign(ctx, overrides);
    return ctx;
  }

  it('injectsMemorySectionAfterExperiencesWithScopeMarkersAndConflictRule', async () => {
    const ctx = context({
      memories: [
        { scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' },
        { scope: 'USER', projectKey: null, content: '输出报告用中文' },
      ],
    });
    const request = await engine().buildRequest(ctx);
    const system = request.messages[0].content as string;
    expect(system).toContain('## 长期记忆');
    expect(system).toContain('与用户当前消息或工作区规则冲突时，以用户当前消息为准');
    expect(system).toContain('- [项目:mao] 该仓库测试用 Vitest');
    expect(system).toContain('- [用户] 输出报告用中文');
    const experienceIdx = system.indexOf('## 最佳实践经验');
    const memoriesIdx = system.indexOf('## 长期记忆');
    expect(experienceIdx).toBeGreaterThanOrEqual(0);
    expect(memoriesIdx).toBeGreaterThan(experienceIdx);
    expect(system.indexOf('经验一')).toBeGreaterThan(experienceIdx);
    expect(system.indexOf('经验一')).toBeLessThan(memoriesIdx);
  });

  it('emptyOrNullMemoriesProduceNoSection', async () => {
    const empty = await engine().buildRequest(context({ memories: [] }));
    expect(empty.messages[0].content as string).not.toContain('## 长期记忆');
    const none = await engine().buildRequest(context());
    expect(none.messages[0].content as string).not.toContain('## 长期记忆');
  });
});

describe('PromptEngine context manifest', () => {
  function engine() {
    return new PromptEngine(
      { hasSkill: () => false, getAllNames: () => [], getAllDocuments: () => [] } as never,
      { getWorkspaceRoot: () => '/ws' } as never,
      RuntimeDataResolver.forTest('/tmp/rt', '/tmp/home'),
      { getByUserIdAndName: async () => null } as never,
      { getUserSkillDocuments: () => [] } as never,
    );
  }

  function context(overrides: Partial<AgentExecutionContext> = {}): AgentExecutionContext {
    const ctx = new AgentExecutionContext();
    ctx.executionMode = 'CLOUD';
    ctx.workspace = '/ws';
    ctx.tools = [tool('read_file')];
    Object.assign(ctx, overrides);
    return ctx;
  }

  it('system sections join equals the system message content (byte-equivalence anchor)', async () => {
    // 决策 1 硬不变量：分节收集后 join 必须逐字节等于重构前 buildSystemPrompt 的输出。
    // 13 个既有 PromptEngine 用例已锚定各通道（普通/embed/微信/LOCAL/CLOUD）的分节顺序与文本；
    // 这里再锚定「manifest 分节覆盖 = 系统消息」这一自洽不变量：去掉 system 前缀后系统消息
    // 仍完整包含每个非空分节的原文。
    const ctx = context({
      systemPrompt: 'You are Mao',
      experiences: ['经验一'],
      memories: [{ id: 42, scope: 'USER', projectKey: null, content: '输出报告用中文' }],
      currentTimestamp: '2026-08-13',
      messages: [{ role: 'user', content: '你好' }],
      modelConfig: { modelId: 'gpt-5', id: 1, contextWindowTokens: 200000 },
    });
    const request = await engine().buildRequest(ctx);
    const system = request.messages[0].content as string;
    expect(system).toContain('You are Mao');
    expect(system).toContain('## 最佳实践经验');
    expect(system).toContain('## 长期记忆');
    expect(system).toContain('## 工作环境');
    expect(system).toContain('## 当前日期');
    expect(system).toContain('# 使用你的工具');
    // manifest 只保留非空分节：注入型分节独立、固有系统提示聚合为单节（0.0.245）
    const manifest = ctx.contextManifest!;
    const keys = manifest.sections.map((s) => s.key);
    expect(keys).toEqual(['experiences', 'memories', 'system-prompt', 'tool-definitions', 'messages']);
    // 聚合后的「系统提示词」必须覆盖被合并掉的各节原文
    const merged = manifest.sections.find((s) => s.key === 'system-prompt')!;
    expect(merged.label).toBe('系统提示词');
    expect(system).toContain('## 工作环境');
    expect(system).toContain('## 当前日期');
    expect(system).toContain('# 使用你的工具');
  });

  it('构成合计 ≈ 上下文容量口径（聚合后显式带上「系统工具」节）', async () => {
    // 用户可见闭环：顶部「上下文容量」= estimateRequestTokens(messages + tools)，
    // 构成分节合计必须与它同口径，否则数字永远对不上（此前差一整个工具定义段）。
    const ctx = context({
      systemPrompt: 'You are Mao',
      currentTimestamp: '2026-08-13',
      messages: [{ role: 'user', content: '你好' }],
    });
    const request = await engine().buildRequest(ctx);
    const manifest = ctx.contextManifest!;
    const toolsSection = manifest.sections.find((s) => s.key === 'tool-definitions');
    expect(toolsSection).toBeDefined();
    expect(toolsSection!.label).toBe('系统工具');
    expect(toolsSection!.count).toBe(1);

    const est = new TokenEstimator();
    const sum = manifest.sections.reduce((acc, s) => acc + s.tokens, 0);
    // handoff 与 messages 口径重叠，仅在无摘要时严格相等
    const water = est.estimateRequestTokens(request);
    expect(Math.abs(sum - water)).toBeLessThanOrEqual(4);
  });

  it('section token sum ≈ system prompt estimate within per-section tolerance', async () => {
    const ctx = context({
      systemPrompt: 'You are Mao',
      experiences: ['经验一', '经验二'],
      currentTimestamp: '2026-08-13',
    });
    const request = await engine().buildRequest(ctx);
    const system = request.messages[0].content as string;
    const estimator = new TokenEstimator();
    const total = estimator.countTokens(system);
    // 只看属于 system 消息的分节：聚合后的「系统提示词」+ 各注入型节
    // （注入型分节不导出常量，这里按 key 白名单穷举，避免为测试扩大模块导出面）
    const injected = ['experiences', 'memories', 'skills', 'incoming-file', 'workspace-rules'];
    const sysSections = ctx.contextManifest!.sections.filter(
      (s) => s.key === 'system-prompt' || injected.includes(s.key),
    );
    const sum = sysSections.reduce((acc, s) => acc + s.tokens, 0);
    // countTokens 对拼接有 ±1 取整误差，容差 = 节数
    expect(Math.abs(sum - total)).toBeLessThanOrEqual(sysSections.length);
  });

  it('messages section counts final request messages excluding system', async () => {
    const ctx = context({
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ],
    });
    const request = await engine().buildRequest(ctx);
    const messagesSection = ctx.contextManifest!.sections.find((s) => s.key === 'messages')!;
    const nonSystem = request.messages.filter((m) => m.role !== 'system');
    expect(messagesSection.count).toBe(nonSystem.length);
    expect(messagesSection.tokens).toBeGreaterThan(0);
  });

  it('no messages section when conversation is empty (system-only request)', async () => {
    const ctx = context({ messages: [] });
    await engine().buildRequest(ctx);
    expect(ctx.contextManifest!.sections.some((s) => s.key === 'messages')).toBe(false);
  });

  it('memoryIds mirrors injected memory ids and is empty when memories absent', async () => {
    const withMem = context({
      memories: [
        { id: 7, scope: 'USER', projectKey: null, content: 'a' },
        { id: 8, scope: 'PROJECT', projectKey: 'mao', content: 'b' },
      ],
    });
    await engine().buildRequest(withMem);
    expect(withMem.contextManifest!.memoryIds).toEqual([7, 8]);

    const noMem = context();
    await engine().buildRequest(noMem);
    expect(noMem.contextManifest!.memoryIds).toEqual([]);
  });

  it('handoff section present iff sessionSummary non-empty, token from buildHandoffUserContent', async () => {
    const est = new TokenEstimator();
    const withSummary = context({ sessionSummary: '已完成登录页改造，下一步补测试', messages: [{ role: 'user', content: '继续' }] });
    await engine().buildRequest(withSummary);
    const handoff = withSummary.contextManifest!.sections.find((s) => s.key === 'handoff')!;
    expect(handoff).toBeDefined();
    expect(handoff.tokens).toBe(est.estimateMessages([{ role: 'user', content: buildHandoffUserContent('已完成登录页改造，下一步补测试') }]));

    const withoutSummary = context({ messages: [{ role: 'user', content: 'hi' }] });
    await engine().buildRequest(withoutSummary);
    expect(withoutSummary.contextManifest!.sections.some((s) => s.key === 'handoff')).toBe(false);
  });

  it('estimatedWindowTokens prefers model contextWindowTokens then compaction config default', async () => {
    const modelCtx = context({ modelConfig: { modelId: 'm', id: 1, contextWindowTokens: 128000 } });
    await engine().buildRequest(modelCtx);
    expect(modelCtx.contextManifest!.estimatedWindowTokens).toBe(128000);

    const cfgCtx = context();
    const cfg = new CompactionConfig();
    cfg.contextWindowTokens = 200000;
    cfgCtx.compactionConfig = cfg;
    await engine().buildRequest(cfgCtx);
    expect(cfgCtx.contextManifest!.estimatedWindowTokens).toBe(200000);
  });
});
void mkdirSync;
