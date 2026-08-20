import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  formatContextPercent,
  resolveContextWindowTokens,
} from '../src/util/context';

describe('formatContextPercent', () => {
  it('treats estimated/actual as tokens, not already-percent values', () => {
    expect(formatContextPercent(13936, undefined, 256000)).toBe('5%');
    expect(formatContextPercent(35680, 36000, 256000)).toBe('14%');
  });

  it('caps at 100% when tokens exceed the window', () => {
    expect(formatContextPercent(300000, undefined, 256000)).toBe('100%');
  });

  it('returns undefined when there is no usage yet', () => {
    expect(formatContextPercent(undefined, undefined)).toBeUndefined();
    expect(formatContextPercent(0, 0)).toBeUndefined();
  });
});

describe('resolveContextWindowTokens', () => {
  it('prefers session.contextWindowTokens', () => {
    expect(resolveContextWindowTokens({ contextWindowTokens: 128000, modelId: 1 }, [{ id: 1, contextWindowTokens: 64000 }], 1)).toBe(128000);
  });

  it('falls back to the selected model then the default', () => {
    expect(resolveContextWindowTokens({ modelId: 2 }, [{ id: 2, contextWindowTokens: 64000 }], 2)).toBe(64000);
    expect(resolveContextWindowTokens({}, [])).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});
