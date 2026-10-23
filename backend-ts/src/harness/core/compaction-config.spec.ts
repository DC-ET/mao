import { describe, expect, it } from 'vitest';
import { CompactionConfig } from './compaction-config.js';

describe('CompactionConfig', () => {
  it('falls back to the global payload threshold when the model limit is unknown', () => {
    const config = new CompactionConfig();
    expect(CompactionConfig.resolveEffectiveTriggerBytes(null, config)).toBe(40 * 1024 * 1024);
    expect(CompactionConfig.resolveEffectiveTriggerBytes({ maxRequestBodyBytes: null }, config)).toBe(40 * 1024 * 1024);
  });

  it('derives the threshold from the declared provider limit at 80%', () => {
    const config = new CompactionConfig();
    const limit = 32 * 1024 * 1024;
    expect(CompactionConfig.resolveEffectiveTriggerBytes({ maxRequestBodyBytes: limit }, config))
      .toBe(Math.floor(limit * 0.8));
  });

  it('never exceeds the global threshold when the provider limit is large', () => {
    const config = new CompactionConfig();
    expect(CompactionConfig.resolveEffectiveTriggerBytes({ maxRequestBodyBytes: 512 * 1024 * 1024 }, config))
      .toBe(40 * 1024 * 1024);
  });

  it('disables payload triggering when the global threshold is 0', () => {
    const config = new CompactionConfig();
    config.triggerPayloadBytes = 0;
    expect(CompactionConfig.resolveEffectiveTriggerBytes({ maxRequestBodyBytes: 50 * 1024 * 1024 }, config)).toBe(0);
  });

  it('triggers on tokens, payload, or both', () => {
    const config = new CompactionConfig();
    const base = {
      triggerWindowTokens: 1000,
      effectiveTriggerBytes: 1000,
      config,
    };
    expect(CompactionConfig.shouldTrigger({ ...base, tokens: 100, payloadBytes: 100 })).toBeNull();
    expect(CompactionConfig.shouldTrigger({ ...base, tokens: 800, payloadBytes: 100 })).toBe('tokens');
    expect(CompactionConfig.shouldTrigger({ ...base, tokens: 100, payloadBytes: 1000 })).toBe('payload');
    expect(CompactionConfig.shouldTrigger({ ...base, tokens: 800, payloadBytes: 1000 })).toBe('both');
  });

  it('ignores payload when the effective threshold is 0', () => {
    const config = new CompactionConfig();
    const result = CompactionConfig.shouldTrigger({
      tokens: 0,
      payloadBytes: 999999,
      triggerWindowTokens: 1000,
      effectiveTriggerBytes: 0,
      config,
    });
    expect(result).toBeNull();
  });
});
