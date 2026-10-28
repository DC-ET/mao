import { describe, expect, it, vi } from 'vitest';
import { HTTP_TOOL_NAMES, createDefaultToolRegistry } from './tool-registry.js';
import type { DefaultToolRegistryDeps } from './tool-registry.js';

/** 只造 registry 依赖里被条件注册分支读到的字段，其余用最小桩。 */
function deps(overrides: Partial<DefaultToolRegistryDeps> = {}): DefaultToolRegistryDeps {
  return {
    pathSandbox: {} as never,
    sessionTodoMapper: {} as never,
    scheduledTaskService: {} as never,
    sessionService: {} as never,
    sessionMapper: { selectById: vi.fn(async () => ({ userId: 7 })) } as never,
    shellSessionManager: {} as never,
    outputManager: {} as never,
    backgroundTaskManager: {} as never,
    webSearch: async () => ({}) as never,
    webPage: {} as never,
    runtimeDataResolver: {} as never,
    imageModelLookup: {} as never,
    uploadDir: '/tmp',
    weixinToolSupport: {} as never,
    weixinUploadService: {} as never,
    weixinSendService: {} as never,
    feishuToolSupport: {} as never,
    feishuMediaDownloader: {} as never,
    feishuGroupMediaLookup: {} as never,
    feishuMessageDetailFetcher: {} as never,
    feishuMaxInboundFileBytes: 1024,
    feishuMediaSendSupport: {} as never,
    dingtalkMediaSendSupport: {} as never,
    definitionRegistry: {} as never,
    harnessService: {} as never,
    agentLoop: {} as never,
    localToolSessionRegistry: {} as never,
    visibilityService: {} as never,
    backgroundSubagentManager: {} as never,
    messageMapper: {} as never,
    sessionCompactionService: {} as never,
    embedPageToolRegistry: {} as never,
    agentMapper: { selectById: vi.fn(async () => ({ id: 2, httpToolIds: null })) } as never,
    ...overrides,
  };
}

const httpToolService = {
  findEnabledWithParams: vi.fn(),
  resolveForExecution: vi.fn(),
};
const httpApiExecutor = { execute: vi.fn() } as never;
const agentMapper = { selectById: vi.fn(async () => ({ id: 2, httpToolIds: null })) } as never;

describe('createDefaultToolRegistry 自定义 HTTP 工具条件注册', () => {
  it('依赖齐备时注册两个入口工具（顺序：describe 在前）', () => {
    const registry = createDefaultToolRegistry(deps({ httpToolService, httpApiExecutor, agentMapper }));
    const names = registry.getAllTools().map((tool) => tool.getName());
    expect(names).toContain('http_describe');
    expect(names).toContain('http_call');
    expect(names.indexOf('http_describe')).toBeLessThan(names.indexOf('http_call'));
  });

  it('任一依赖缺失时不注册（精简装配工具集不变）', () => {
    for (const overrides of [
      {},
      { httpToolService, httpApiExecutor, agentMapper: null },
      { httpToolService: null, httpApiExecutor, agentMapper },
      { httpToolService, httpApiExecutor: null, agentMapper },
      { httpToolService: null, httpApiExecutor: null, agentMapper: null },
    ] as Partial<DefaultToolRegistryDeps>[]) {
      const names = createDefaultToolRegistry(deps(overrides)).getAllTools().map((tool) => tool.getName());
      expect(names).not.toContain('http_describe');
      expect(names).not.toContain('http_call');
    }
  });

  it('入口工具可被名称取到（/v1/tools 枚举与装配推入同源）', () => {
    const registry = createDefaultToolRegistry(deps({ httpToolService, httpApiExecutor, agentMapper }));
    for (const name of HTTP_TOOL_NAMES) {
      const tool = registry.getTool(name);
      expect(tool, name).toBeDefined();
      expect(tool!.getName()).toBe(name);
      expect(tool!.getDescription().length).toBeGreaterThan(0);
      expect(tool!.getInputSchema()).toMatchObject({ type: 'object' });
    }
  });

  it('入口工具的输入 schema 不含任何自定义工具的具体参数（懒加载宪法）', () => {
    const registry = createDefaultToolRegistry(deps({ httpToolService, httpApiExecutor, agentMapper }));
    const callSchema = JSON.stringify(registry.getTool('http_call')!.getInputSchema());
    // 只有外壳参数 tool / arguments，不出现具体业务字段
    expect(callSchema).toContain('"tool"');
    expect(callSchema).toContain('"arguments"');
    expect(callSchema).not.toContain('city');
    expect(JSON.stringify(registry.getTool('http_describe')!.getInputSchema())).not.toContain('city');
  });
});
