import { describe, expect, it, vi } from 'vitest';
import { ApprovalModelResolver } from './approval-model-resolver.js';
import type { LlmModelConfig } from '../llm/chat-request.js';
import type { LlmModel } from '../../model/types.js';

describe('ApprovalModelResolver', () => {
  const fallback = { modelId: 'session-model' } as LlmModelConfig;
  const configuredModel: LlmModel = {
    id: 42, name: 'approval-model', baseUrl: 'https://api.example.com', apiKey: 'k', modelId: 'm-1',
  };

  it('returns configured model when setting is valid', async () => {
    const resolver = new ApprovalModelResolver(
      vi.fn(async () => '42'),
      vi.fn(async () => configuredModel),
    );
    const resolved = await resolver.resolve(fallback);
    expect(resolved?.modelId).toBe('m-1');
    expect(resolved?.id).toBe(42);
  });

  it('falls back when setting is empty', async () => {
    const resolver = new ApprovalModelResolver(vi.fn(async () => ''), vi.fn());
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when setting is null', async () => {
    const resolver = new ApprovalModelResolver(vi.fn(async () => null), vi.fn());
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when setting is not a number', async () => {
    const resolver = new ApprovalModelResolver(vi.fn(async () => 'abc'), vi.fn());
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when configured model does not exist', async () => {
    const resolver = new ApprovalModelResolver(vi.fn(async () => '42'), vi.fn(async () => null));
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when configured model is deleted', async () => {
    const resolver = new ApprovalModelResolver(
      vi.fn(async () => '42'),
      vi.fn(async () => ({ ...configuredModel, deleted: 1 })),
    );
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when setting read throws', async () => {
    const resolver = new ApprovalModelResolver(
      vi.fn(async () => { throw new Error('db down'); }),
      vi.fn(),
    );
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('falls back when model lookup throws', async () => {
    const resolver = new ApprovalModelResolver(
      vi.fn(async () => '42'),
      vi.fn(async () => { throw new Error('db down'); }),
    );
    expect(await resolver.resolve(fallback)).toBe(fallback);
  });

  it('propagates null fallback when session model is also absent', async () => {
    const resolver = new ApprovalModelResolver(vi.fn(async () => ''), vi.fn());
    expect(await resolver.resolve(null)).toBeNull();
  });
});
