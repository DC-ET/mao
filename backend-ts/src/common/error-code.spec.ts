import { describe, expect, it } from 'vitest';
import { ErrorCode } from './error-code.js';

describe('ErrorCode', () => {
  it('keeps Java numeric codes', () => {
    expect(ErrorCode.UNAUTHORIZED.code).toBe(1001);
    expect(ErrorCode.FORBIDDEN.code).toBe(1002);
    expect(ErrorCode.LOGIN_FAILED.code).toBe(1005);
    expect(ErrorCode.PARAM_INVALID.code).toBe(2001);
    expect(ErrorCode.AGENT_NOT_FOUND.code).toBe(3001);
    expect(ErrorCode.MESSAGE_ALREADY_COMPACTED.code).toBe(3027);
    expect(ErrorCode.INTERNAL_ERROR.code).toBe(5001);
    expect(ErrorCode.GIT_CLONE_FAILED.code).toBe(5005);
  });
});
