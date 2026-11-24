import { describe, expect, it } from 'vitest';
import { BaseTool, callTool } from './tool.js';

/** 探针工具：把收到的位置参数原样记下来，便于断言 arity 路由。 */
class ProbeTool extends BaseTool {
  seen: unknown[][] = [];

  getName(): string { return 'probe'; }
  getDescription(): string { return 'probe'; }
  getInputSchema(): Record<string, unknown> { return { type: 'object' }; }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    workspace: string | null,
    agentId: number | null = null,
  ): string {
    this.seen.push([argumentsJson, sessionId, userId, workspace, agentId]);
    return 'ok';
  }
}

/** 只覆盖 4 参的旧工具（改造前就存在的形态）：必须继续收到 4 个参数。 */
class LegacyTool extends BaseTool {
  seen: unknown[][] = [];

  getName(): string { return 'legacy'; }
  getDescription(): string { return 'legacy'; }
  getInputSchema(): Record<string, unknown> { return { type: 'object' }; }
  getOutputSchema(): Record<string, unknown> { return { type: 'object' }; }

  protected executeWithUser(
    argumentsJson: string,
    sessionId: number | null,
    userId: number | null,
    workspace: string | null,
  ): string {
    this.seen.push([argumentsJson, sessionId, userId, workspace]);
    return 'ok';
  }
}

describe('BaseTool.execute arity 路由（agentId 透传，技术方案 2026-11-24 D5）', () => {
  it('routes the 5-arg form and forwards agentId', () => {
    const tool = new ProbeTool();
    expect(tool.execute('{"a":1}', 11, 7, 'ws', 3)).toBe('ok');
    expect(tool.seen).toEqual([['{"a":1}', 11, 7, 'ws', 3]]);
  });

  it('still routes the legacy 4-arg form unchanged', () => {
    const tool = new ProbeTool();
    expect(tool.execute('{"a":1}', 11, 7, 'ws')).toBe('ok');
    // 第 5 参缺省 → null，与「无 agent 归属」同义
    expect(tool.seen).toEqual([['{"a":1}', 11, 7, 'ws', null]]);
  });

  it('keeps the 1/2/3-arg workspace-only forms unchanged', () => {
    const tool = new ProbeTool();
    expect(tool.execute('{"a":1}')).toBe('ok');
    expect(tool.execute('{"a":1}', 'ws')).toBe('ok');
    expect(tool.execute('{"a":1}', 11, 'ws')).toBe('ok');
    expect(tool.seen).toEqual([
      ['{"a":1}', null, null, null, null],
      ['{"a":1}', null, null, 'ws', null],
      ['{"a":1}', 11, null, 'ws', null],
    ]);
  });

  it('a tool overriding only the 4-arg form still works (TS 少参兼容)', () => {
    const tool = new LegacyTool();
    expect(tool.execute('{"a":1}', 11, 7, 'ws')).toBe('ok');
    // 5 参调用也不会炸：基类把第 5 参归一成 null 后交给 4 参实现
    expect(tool.execute('{"a":1}', 11, 7, 'ws', 3)).toBe('ok');
    expect(tool.seen).toEqual([
      ['{"a":1}', 11, 7, 'ws'],
      ['{"a":1}', 11, 7, 'ws'],
    ]);
  });

  it('callTool forwards agentId as the 5th argument', async () => {
    const tool = new ProbeTool();
    await callTool(tool, '{"a":1}', 11, 7, 'ws', 3);
    expect(tool.seen).toEqual([['{"a":1}', 11, 7, 'ws', 3]]);
  });

  it('callTool without agentId is byte-for-byte the old call shape', async () => {
    const tool = new ProbeTool();
    await callTool(tool, '{"a":1}', 11, 7, 'ws');
    expect(tool.seen).toEqual([['{"a":1}', 11, 7, 'ws', null]]);
  });

  it('callTool workspace-only form is unchanged', async () => {
    const tool = new ProbeTool();
    await callTool(tool, '{"a":1}', undefined, undefined, 'ws');
    await callTool(tool, '{"a":1}');
    expect(tool.seen).toEqual([
      ['{"a":1}', null, null, 'ws', null],
      ['{"a":1}', null, null, null, null],
    ]);
  });
});
