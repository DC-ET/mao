import { describe, expect, it } from 'vitest';
import { normalizeRuntimeMode } from './user.service.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

describe('normalizeRuntimeMode', () => {
  it('acceptsDockerHostAndClearingValues', () => {
    expect(normalizeRuntimeMode('docker')).toBe('docker');
    expect(normalizeRuntimeMode('host')).toBe('host');
    expect(normalizeRuntimeMode(' docker ')).toBe('docker');
    expect(normalizeRuntimeMode(null)).toBeNull();
    expect(normalizeRuntimeMode(undefined)).toBeNull();
    expect(normalizeRuntimeMode('')).toBeNull();
    expect(normalizeRuntimeMode('  ')).toBeNull();
  });

  it('rejectsUnknownModes', () => {
    try {
      normalizeRuntimeMode('container');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessException);
      expect((e as BusinessException).code).toBe(ErrorCode.PARAM_INVALID.code);
    }
  });
});
