import { describe, expect, it } from 'vitest';
import { assertEcpEnabled, EcpError } from './ecp.error.js';

describe('ecp.error', () => {
  it('requires ecp enabled for ecp routes', () => {
    expect(() => assertEcpEnabled(false)).toThrow(EcpError);
    expect(() => assertEcpEnabled(true)).not.toThrow();
  });
});
