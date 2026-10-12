import { describe, expect, it, vi } from 'vitest';
import { isSupported, markUnsupported, resetPromptCacheSupportForTest, shouldDegrade } from './prompt-cache-key-support.js';
import type { LlmModelConfig } from './chat-request.js';
import * as harnessLogModule from '../log.js';

function config(baseUrl: string, modelId: string): LlmModelConfig {
  return { baseUrl, apiKey: 'key', modelId };
}

describe('prompt-cache-key-support', () => {
  it('未登记时两个 feature 都视为支持', () => {
    resetPromptCacheSupportForTest();
    const cfg = config('https://gw.example.com/v1', 'gpt-test');
    expect(isSupported(cfg, 'prompt_cache_key')).toBe(true);
    expect(isSupported(cfg, 'cache_control')).toBe(true);
  });

  it('markUnsupported 后该模型不再支持，且重复登记幂等', () => {
    resetPromptCacheSupportForTest();
    const cfg = config('https://gw.example.com/v1', 'gpt-test');
    markUnsupported(cfg, 'prompt_cache_key', 'unknown field prompt_cache_key');
    markUnsupported(cfg, 'prompt_cache_key', 'unknown field prompt_cache_key');
    expect(isSupported(cfg, 'prompt_cache_key')).toBe(false);
    // 同一模型的其他 feature 不受影响
    expect(isSupported(cfg, 'cache_control')).toBe(true);
  });

  it('降级键按 baseUrl|modelId 隔离', () => {
    resetPromptCacheSupportForTest();
    const a = config('https://gw-a.example.com/v1', 'gpt-test');
    const b = config('https://gw-b.example.com/v1', 'gpt-test');
    const c = config('https://gw-a.example.com/v1', 'gpt-other');
    markUnsupported(a, 'prompt_cache_key', 'unknown field prompt_cache_key');
    expect(isSupported(a, 'prompt_cache_key')).toBe(false);
    expect(isSupported(b, 'prompt_cache_key')).toBe(true);
    expect(isSupported(c, 'prompt_cache_key')).toBe(true);
  });

  it('baseUrl 与 modelId 均缺失时按模型主键 id 隔离', () => {
    // 两个网关地址与模型名都空、只有主键不同的配置（同一网关同一模型的重复登记行）
    // 必须互相隔离：否则一个被降级会把另一个的缓存字段也一起毙掉。
    resetPromptCacheSupportForTest();
    const a = { baseUrl: undefined, modelId: undefined, id: 1, apiKey: 'k' } as LlmModelConfig;
    const b = { baseUrl: undefined, modelId: undefined, id: 2, apiKey: 'k' } as LlmModelConfig;
    const sameAgain = { baseUrl: undefined, modelId: undefined, id: 1, apiKey: 'k' } as LlmModelConfig;
    markUnsupported(a, 'prompt_cache_key', 'unknown field prompt_cache_key');
    expect(isSupported(a, 'prompt_cache_key')).toBe(false);
    expect(isSupported(sameAgain, 'prompt_cache_key')).toBe(false);
    expect(isSupported(b, 'prompt_cache_key')).toBe(true);
  });

  it('baseUrl/modelId 为空串时与 undefined 视作同一空值，不因空串另立一键', () => {
    resetPromptCacheSupportForTest();
    const blank = { baseUrl: '', modelId: '', id: 3, apiKey: 'k' } as LlmModelConfig;
    const missing = { baseUrl: undefined, modelId: undefined, id: 3, apiKey: 'k' } as LlmModelConfig;
    markUnsupported(blank, 'cache_control', 'unknown field cache_control');
    expect(isSupported(missing, 'cache_control')).toBe(false);
  });

  it.each([
    ['400 且点名 prompt_cache_key', 400, '{"error":{"message":"unknown field: prompt_cache_key"}}', 'prompt_cache_key', true],
    ['400 且 unknown + cache', 400, '{"error":{"message":"unrecognized cache field"}}', 'prompt_cache_key', true],
    ['400 错误体无关字段', 400, '{"error":{"message":"invalid schema for messages"}}', 'prompt_cache_key', false],
    ['400 但只说 unknown 无 cache', 400, '{"error":{"message":"unknown parameter foo"}}', 'prompt_cache_key', false],
    ['403 不降级', 403, 'unknown field prompt_cache_key', 'prompt_cache_key', false],
    ['429 不降级', 429, 'unknown field prompt_cache_key', 'prompt_cache_key', false],
    ['500 不降级', 500, 'unknown field prompt_cache_key', 'prompt_cache_key', false],
    ['空错误体不降级', 400, '', 'prompt_cache_key', false],
    ['cache_control 字段同判据', 400, 'unknown field cache_control', 'cache_control', true],
  ])('shouldDegrade: %s', (_label, status, body, feature, expected) => {
    resetPromptCacheSupportForTest();
    expect(shouldDegrade(status, body, feature as 'prompt_cache_key' | 'cache_control')).toBe(expected);
  });

  it('markUnsupported 打 warn 日志并带上下文', () => {
    resetPromptCacheSupportForTest();
    const logSpy = vi.spyOn(harnessLogModule, 'harnessLog').mockImplementation(() => undefined);
    try {
      markUnsupported(config('https://gw.example.com/v1', 'gpt-test'), 'prompt_cache_key', 'unknown field prompt_cache_key');
      expect(logSpy).toHaveBeenCalledWith(
        'warn',
        expect.stringContaining('prompt cache feature degraded'),
      );
      expect(logSpy.mock.calls[0][1]).toContain('modelId=gpt-test');
      expect(logSpy.mock.calls[0][1]).toContain('feature=prompt_cache_key');
    } finally {
      logSpy.mockRestore();
    }
  });
});
