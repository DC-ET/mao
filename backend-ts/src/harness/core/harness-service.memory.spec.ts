import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionContext } from './agent-execution-context.js';
import { CompactionConfig } from './compaction-config.js';
import { HarnessService } from './harness-service.js';
import type { Tool } from '../tool/tool.js';
import type { AgentLoop } from './agent-loop.js';
import type { ToolRegistry } from '../tool/tool-registry.js';

function fakeTool(name: string): Tool {
  return {
    getName: () => name,
    getDescription: () => name,
    getInputSchema: () => ({}),
    getOutputSchema: () => ({}),
    execute: () => '',
  };
}

const SESSION = {
  id: 11,
  userId: 7,
  agentId: 2,
  modelId: 5,
  title: '任务',
  executionMode: 'LOCAL',
  status: 'ACTIVE',
  phase: 'RUNNING',
  sessionType: 'NORMAL',
  projectKey: 'mao',
  workspace: '/Users/me/mao',
};

const AGENT = { id: 2, name: 'coder', systemPrompt: 'you code', skillNames: null };

const MODEL = {
  id: 5,
  name: 'flash',
  provider: 'openai',
  baseUrl: 'https://api.example.com',
  apiKey: 'sk-test',
  modelId: 'flash-1',
  contextWindowTokens: 128000,
  supportsVision: 0,
};

/** 组装 buildContext 可运行的最小依赖（LOCAL 模式，关闭压缩）。 */
function buildHarness(memoryInjection: { listForInjection: (...args: never[]) => Promise<unknown> } | null) {
  const sessionMapper = {
    selectById: vi.fn(async () => SESSION),
  };
  const agentMapper = {
    selectById: vi.fn(async () => AGENT),
  };
  const llmModelMapper = {
    selectById: vi.fn(async () => MODEL),
    selectDefault: vi.fn(async () => MODEL),
  };
  const experienceService = { listEnabledContents: vi.fn(async () => ['经验一']) };
  const sessionService = {
    cleanupIncompleteTailAfterId: vi.fn(async () => undefined),
    loadContextAnchor: vi.fn(async () => ({ lastPromptTokens: 0, contextAnchorMsgId: 0 })),
  };
  const sessionCompactionService = {
    loadValidated: vi.fn(async () => null),
    boundaryOf: vi.fn(() => 0),
  };
  const sessionHistoryLoader = {
    loadHistoryAfterBoundary: vi.fn(async () => ({ persistedMessages: [], messages: [] })),
    applyHistory: vi.fn(async () => undefined),
  };
  const skillSyncService = {
    getUserSkillNames: vi.fn(() => [] as string[]),
    getUserSkillDocuments: vi.fn(() => []),
  };
  const localSkillRegistry = { get: vi.fn(() => []) };
  const localAgentsMdRegistry = { get: vi.fn(() => null) };
  const toolRegistry = { getAllTools: vi.fn(() => [fakeTool('read_file')]) as () => Tool[] };
  const promptEngine = { buildRequest: vi.fn(async () => ({ messages: [] })) };
  const environmentInfoProvider = {
    fromSessionOrDetect: vi.fn(async () => ({ isGit: true, platform: 'darwin', shell: 'bash', osVersion: 'macOS' })),
  };
  const compactionConfig = { enabled: false } as CompactionConfig;

  const harness = new HarnessService(
    {} as never as AgentLoop,
    toolRegistry as never as ToolRegistry,
    { hasSkill: vi.fn(() => false), getAllDocuments: vi.fn(() => []) } as never,
    skillSyncService as never,
    localSkillRegistry as never,
    localAgentsMdRegistry as never,
    sessionMapper as never,
    agentMapper as never,
    experienceService as never,
    llmModelMapper as never,
    {} as never,
    sessionService as never,
    sessionCompactionService as never,
    sessionHistoryLoader as never,
    {} as never,
    promptEngine as never,
    {} as never,
    compactionConfig,
    environmentInfoProvider as never,
    null,
    null,
    null,
    null,
    memoryInjection as never,
  );
  return { harness, experienceService, memoryInjection };
}

describe('HarnessService buildContext memory injection', () => {
  it('loadsMemoriesIntoContext', async () => {
    const memoryInjection = {
      listForInjection: vi.fn(async () => [
        { scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' },
        { scope: 'USER', projectKey: null, content: '输出报告用中文' },
      ]),
    };
    const { harness } = buildHarness(memoryInjection);
    const context = await harness.buildContext(11, null, null);
    expect(memoryInjection.listForInjection).toHaveBeenCalledWith(7, 'mao', '/Users/me/mao');
    expect(context.memories).toEqual([
      { scope: 'PROJECT', projectKey: 'mao', content: '该仓库测试用 Vitest' },
      { scope: 'USER', projectKey: null, content: '输出报告用中文' },
    ]);
  });

  it('memoryQueryFailureDegradesToNullAndSessionStillStarts', async () => {
    const memoryInjection = {
      listForInjection: vi.fn(async () => {
        throw new Error('memory db down');
      }),
    };
    const { harness } = buildHarness(memoryInjection);
    const context = await harness.buildContext(11, null, null);
    expect(context).toBeInstanceOf(AgentExecutionContext);
    expect(context.memories).toBeNull();
    expect(context.experiences).toEqual(['经验一']);
    expect(context.modelConfig?.modelId).toBe('flash-1');
  });

  it('skipsMemoryLookupWithoutInjectionDependency', async () => {
    const { harness, memoryInjection } = buildHarness(null);
    const context = await harness.buildContext(11, null, null);
    expect(context.memories).toBeNull();
    expect(memoryInjection).toBeNull();
  });
});
