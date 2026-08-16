import { describe, expect, it } from 'vitest';
import { BusinessException } from './business-exception.js';
import { ErrorCode } from './error-code.js';

describe('BusinessException', () => {
  it('constructorsPreserveCodeAndMessage', () => {
    const byCode = new BusinessException(ErrorCode.PARAM_INVALID);
    const customMessage = new BusinessException(ErrorCode.PARAM_INVALID, '参数 bad');
    const customCode = new BusinessException(499, 'custom');

    expect(byCode.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(byCode.message).toBe(ErrorCode.PARAM_INVALID.message);
    expect(customMessage.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(customMessage.message).toBe('参数 bad');
    expect(customCode.code).toBe(499);
    expect(customCode.message).toBe('custom');
  });
});
