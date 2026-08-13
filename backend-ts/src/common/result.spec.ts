import { describe, expect, it } from 'vitest';
import { ErrorCode } from './error-code.js';
import { fail, failCode, ok } from './result.js';

describe('Result', () => {
  it('okBuildsSuccessResponseWithTimestamp', () => {
    const result = ok('data');
    expect(result.code).toBe(0);
    expect(result.message).toBe('success');
    expect(result.data).toBe('data');
    expect(result.timestamp).toBeGreaterThan(0);
  });

  it('failBuildsErrorResponses', () => {
    const custom = fail(123, 'bad');
    const fromCode = failCode(ErrorCode.PARAM_INVALID);
    expect(custom.code).toBe(123);
    expect(custom.message).toBe('bad');
    expect(fromCode.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(fromCode.message).toBe(ErrorCode.PARAM_INVALID.message);
  });

  it('okOmitsNullData', () => {
    const result = ok();
    expect(result.data).toBeUndefined();
  });
});
