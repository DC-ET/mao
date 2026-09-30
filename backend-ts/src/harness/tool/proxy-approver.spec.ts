import { describe, expect, it, vi } from 'vitest';
import { ProxyApprover } from './proxy-approver.js';
import type { ChatResponse, LlmAdapter, LlmModelConfig } from '../llm/chat-request.js';

describe('ProxyApprover', () => {
  const modelConfig = { modelId: 'test-model' } as LlmModelConfig;

  function adapterWith(content: string | null): LlmAdapter {
    const response: ChatResponse = { choices: [{ message: { content: content ?? '' } }] };
    return { chat: vi.fn(async () => response), stream: vi.fn() } as unknown as LlmAdapter;
  }

  it('parses APPROVE with reason', async () => {
    const approver = new ProxyApprover(adapterWith('APPROVE: 用户要求清理构建产物，命令目标在 dist 目录内'));
    const verdict = await approver.decide(
      { toolName: 'shell', argumentsJson: '{"command":"rm -rf ./dist"}', contextSnapshot: '## 用户指令\n1. 清理构建产物' },
      modelConfig,
    );
    expect(verdict).toEqual({ ok: true, approved: true, reason: '用户要求清理构建产物，命令目标在 dist 目录内' });
  });

  it('parses DENY with reason', async () => {
    const approver = new ProxyApprover(adapterWith('DENY: 该命令会删除用户未要求触碰的目录'));
    const verdict = await approver.decide(
      { toolName: 'shell', argumentsJson: '{"command":"rm -rf ~/Documents"}', contextSnapshot: null },
      modelConfig,
    );
    expect(verdict).toEqual({ ok: true, approved: false, reason: '该命令会删除用户未要求触碰的目录' });
  });

  it('uses default reason when verdict has no body', async () => {
    const approver = new ProxyApprover(adapterWith('APPROVE'));
    const verdict = await approver.decide({ toolName: 'shell', argumentsJson: '{}', contextSnapshot: null }, modelConfig);
    expect(verdict).toEqual({ ok: true, approved: true, reason: 'AI 审批通过' });
  });

  it('returns ok=false on unparseable output', async () => {
    const approver = new ProxyApprover(adapterWith('我觉得可以执行'));
    const verdict = await approver.decide({ toolName: 'shell', argumentsJson: '{}', contextSnapshot: null }, modelConfig);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('审批结果无法解析');
  });

  it('returns ok=false on empty output', async () => {
    const approver = new ProxyApprover(adapterWith(''));
    const verdict = await approver.decide({ toolName: 'shell', argumentsJson: '{}', contextSnapshot: null }, modelConfig);
    expect(verdict.ok).toBe(false);
  });

  it('returns ok=false when chat throws', async () => {
    const adapter = { chat: vi.fn(async () => { throw new Error('rate limited'); }), stream: vi.fn() } as unknown as LlmAdapter;
    const approver = new ProxyApprover(adapter);
    const verdict = await approver.decide({ toolName: 'shell', argumentsJson: '{}', contextSnapshot: null }, modelConfig);
    expect(verdict).toEqual({ ok: false, approved: false, reason: 'rate limited' });
  });

  it('truncates oversized pending arguments in the prompt', async () => {
    const chat = vi.fn(async () => ({ choices: [{ message: { content: 'APPROVE: ok' } }] }));
    const approver = new ProxyApprover({ chat, stream: vi.fn() } as unknown as LlmAdapter);
    const hugeArgs = JSON.stringify({ data: 'x'.repeat(5000) });
    await approver.decide({ toolName: 'mcp__a__b', argumentsJson: hugeArgs, contextSnapshot: null }, modelConfig);
    const request = chat.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const userContent = request.messages[1].content;
    expect(userContent.length).toBeLessThan(3000);
    expect(userContent).toContain('[截断]');
  });
});
