import { describe, expect, it, vi } from 'vitest';
import { HttpCallTool, HttpDescribeTool, httpCallTarget, parseCallArguments } from './http-api-tools.js';
import type { HttpToolWithParams } from '../../../http-tool/types.js';

const SESSION_ID = 7;
const AGENT = { id: 5, httpToolIds: JSON.stringify([3]) };

function found(toolName = 'weather'): HttpToolWithParams {
  return {
    tool: {
      id: 3,
      name: toolName,
      displayName: '天气查询',
      description: '查询城市天气',
      method: 'GET',
      url: 'https://api.example.com/v1/weather',
      headersJson: null,
      bodyTemplate: null,
      readOnly: 1,
      timeoutMs: 15000,
      enabled: 1,
    },
    params: [
      { id: 1, toolId: 3, name: 'city', label: '城市', type: 'string', required: 1, defaultValue: null, sortOrder: 0 },
      { id: 2, toolId: 3, name: 'unit', label: '单位', type: 'string', required: 0, defaultValue: 'c', sortOrder: 1 },
    ],
  };
}

/** 组装两个工具：httpToolService 桩 + executor 桩；sessionId → agentId 固定映射。 */
function makeTools(options: {
  found?: HttpToolWithParams | null;
  resolve?: Awaited<ReturnType<never>> | null;
  sessionMissing?: boolean;
  agentMissing?: boolean;
  decryptThrows?: boolean;
} = {}) {
  const sessionMapper = {
    selectById: vi.fn(async () => (options.sessionMissing ? null : { userId: 9, agentId: 5, executionMode: 'CLOUD' })),
  };
  const agentMapper = {
    selectById: vi.fn(async () => (options.agentMissing ? null : AGENT)),
  };
  const httpToolService = {
    findEnabledWithParams: vi.fn(async () => ('found' in options ? options.found : found())),
    resolveForExecution: vi.fn(async () => {
      if (options.decryptThrows) throw new Error('decrypt failed');
      if ('resolve' in options) return options.resolve;
      return {
        tool: {
          name: 'weather', displayName: '天气查询', method: 'GET',
          url: 'https://api.example.com/v1/weather', headers: {}, bodyTemplate: null, timeoutMs: 15000,
        },
        params: found().params,
      };
    }),
  };
  const executor = { execute: vi.fn(async () => ({ status: 200, body: '{"temp":26}', truncated: false, displayName: '天气查询' })) };
  return {
    sessionMapper,
    agentMapper,
    httpToolService,
    executor,
    describeTool: new HttpDescribeTool({ sessionMapper: sessionMapper as never, agentMapper: agentMapper as never, httpToolService }),
    callTool: new HttpCallTool({ sessionMapper: sessionMapper as never, agentMapper: agentMapper as never, httpToolService, executor: executor as never }),
  };
}

function parse(result: string | Promise<string>): Record<string, unknown> {
  return JSON.parse(result as string) as Record<string, unknown>;
}

describe('HttpDescribeTool', () => {
  it('returns the parameter schema for a tool associated with the session agent', async () => {
    const { describeTool, httpToolService } = makeTools();
    const result = parse(await describeTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(result).toMatchObject({ name: 'weather', displayName: '天气查询', method: 'GET', readOnly: true });
    expect(result.params).toHaveLength(2);
    expect(httpToolService.findEnabledWithParams).toHaveBeenCalledWith(AGENT, 'weather');
  });

  it('does not hit the network and never leaks header ciphertext', async () => {
    const { describeTool } = makeTools({
      found: { ...found(), tool: { ...found().tool, headersJson: '{"Authorization":"enc:abc"}' } },
    });
    const result = parse(await describeTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(JSON.stringify(result)).not.toContain('enc:');
  });

  it('rejects missing / non-object / empty tool arguments', async () => {
    const { describeTool, httpToolService } = makeTools();
    expect(parse(await describeTool.execute('{}', SESSION_ID)).error).toContain('缺少 tool');
    expect(parse(await describeTool.execute('{bad', SESSION_ID)).error).toContain('不是合法 JSON');
    expect(parse(await describeTool.execute('"weather"', SESSION_ID)).error).toContain('必须是 JSON 对象');
    expect(httpToolService.findEnabledWithParams).not.toHaveBeenCalled();
  });

  it('reports unknown or disabled tools distinctly', async () => {
    const { describeTool } = makeTools({ found: null });
    const result = parse(await describeTool.execute(JSON.stringify({ tool: 'ghost' }), SESSION_ID));
    expect(result.error).toBe('工具不存在或未启用：ghost');
  });

  it('requires a session context to resolve the agent', async () => {
    const { describeTool, httpToolService } = makeTools({ sessionMissing: true });
    const result = parse(await describeTool.execute(JSON.stringify({ tool: 'weather' }), null));
    expect(result.error).toContain('需要会话上下文');
    expect(httpToolService.findEnabledWithParams).not.toHaveBeenCalled();
  });

  it('requires the session agent to exist', async () => {
    const { describeTool, httpToolService } = makeTools({ agentMissing: true });
    const result = parse(await describeTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(result.error).toContain('需要会话上下文');
    expect(httpToolService.findEnabledWithParams).not.toHaveBeenCalled();
  });
});

describe('HttpCallTool', () => {
  it('executes through the kernel and returns the normalized result', async () => {
    const { callTool, executor, httpToolService } = makeTools();
    const result = parse(await callTool.execute(
      JSON.stringify({ tool: 'weather', arguments: { city: '上海' } }), SESSION_ID,
    ));
    expect(result).toMatchObject({ status: 200, body: '{"temp":26}' });
    expect(httpToolService.resolveForExecution).toHaveBeenCalledWith(AGENT, 'weather');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  it('defaults a missing arguments field to an empty object', async () => {
    const { callTool, executor } = makeTools();
    await callTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID);
    expect(executor.execute.mock.calls[0]![2]).toBe('{}');
  });

  it('rejects malformed / non-object shell arguments without calling the kernel', async () => {
    const { callTool, executor } = makeTools();
    expect(parse(await callTool.execute('{bad', SESSION_ID)).error).toContain('不是合法 JSON');
    expect(parse(await callTool.execute('["x"]', SESSION_ID)).error).toContain('必须是 JSON 对象');
    expect(parse(await callTool.execute(JSON.stringify({ arguments: { city: 'SH' } }), SESSION_ID)).error)
      .toContain('缺少 tool');
    expect(parse(await callTool.execute(JSON.stringify({ tool: 'weather', arguments: [1] }), SESSION_ID)).error)
      .toContain('arguments 必须是 JSON 对象');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('rejects oversized arguments before any resolution', async () => {
    const { callTool, httpToolService, executor } = makeTools();
    const result = parse(await callTool.execute(
      JSON.stringify({ tool: 'weather', arguments: { blob: 'x'.repeat(70 * 1024) } }), SESSION_ID,
    ));
    expect(result.error).toContain('参数过大');
    expect(httpToolService.resolveForExecution).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('reports unknown or disabled tools distinctly', async () => {
    const { callTool, executor } = makeTools({ resolve: null });
    const result = parse(await callTool.execute(JSON.stringify({ tool: 'ghost' }), SESSION_ID));
    expect(result.error).toBe('工具不存在或未启用：ghost');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('fails closed with a readable message when header decryption fails', async () => {
    const { callTool, executor } = makeTools({ decryptThrows: true });
    const result = parse(await callTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(result.error).toContain('解密失败');
    expect(result.error).toContain('重新保存');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('requires a session context to resolve the agent', async () => {
    const { callTool, httpToolService } = makeTools({ sessionMissing: true });
    const result = parse(await callTool.execute(JSON.stringify({ tool: 'weather' }), null));
    expect(result.error).toContain('需要会话上下文');
    expect(httpToolService.resolveForExecution).not.toHaveBeenCalled();
  });

  it('surfaces kernel failures (SSRF deny / HTTP status) as error payloads', async () => {
    const sessionMapper = { selectById: vi.fn(async () => ({ userId: 9, agentId: 5 })) };
    const agentMapper = { selectById: vi.fn(async () => AGENT) };
    const httpToolService = {
      findEnabledWithParams: vi.fn(),
      resolveForExecution: vi.fn(async () => ({
        tool: {
          name: 'weather', displayName: '天气查询', method: 'GET',
          url: 'https://api.example.com/v1/weather', headers: {}, bodyTemplate: null, timeoutMs: 15000,
        },
        params: found().params,
      })),
    };
    const executor = { execute: vi.fn(async () => ({ error: '请求被拒绝：目标地址不在允许访问的网段内' })) };
    const callTool = new HttpCallTool({ sessionMapper: sessionMapper as never, agentMapper: agentMapper as never, httpToolService, executor: executor as never });
    const result = parse(await callTool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(result.error).toContain('请求被拒绝');
  });

  it('errors clearly when the execution kernel is not assembled', async () => {
    const sessionMapper = { selectById: vi.fn(async () => ({ userId: 9, agentId: 5 })) };
    const agentMapper = { selectById: vi.fn(async () => AGENT) };
    const httpToolService = {
      findEnabledWithParams: vi.fn(),
      resolveForExecution: vi.fn(async () => ({
        tool: {
          name: 'weather', displayName: '天气查询', method: 'GET',
          url: 'https://api.example.com/v1/weather', headers: {}, bodyTemplate: null, timeoutMs: 15000,
        },
        params: found().params,
      })),
    };
    const tool = new HttpCallTool({ sessionMapper: sessionMapper as never, agentMapper: agentMapper as never, httpToolService, executor: null });
    const result = parse(await tool.execute(JSON.stringify({ tool: 'weather' }), SESSION_ID));
    expect(result.error).toContain('执行内核未装配');
  });
});

describe('parseCallArguments / httpCallTarget', () => {
  it('extracts the inner tool slug for the activity target', () => {
    expect(parseCallArguments(JSON.stringify({ tool: 'weather', arguments: { a: 1 } })))
      .toEqual({ tool: 'weather', argumentsJson: '{"a":1}' });
    expect(httpCallTarget(JSON.stringify({ tool: 'weather' }))).toBe('weather');
    expect(httpCallTarget(JSON.stringify({ tool: '  ' }))).toBeNull();
    expect(httpCallTarget('not-json')).toBeNull();
    expect(httpCallTarget(null)).toBeNull();
    expect(httpCallTarget('[1]')).toBeNull();
  });
});
