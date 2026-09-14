import { describe, expect, it } from 'vitest';
import { assertEcpDisabled } from './ecp.error.js';

describe('ecp.error', () => {
  it('blocks legacy login when ecp enabled', () => {
    expect(() => assertEcpDisabled(true)).toThrow(/ECP/);
    expect(() => assertEcpDisabled(false)).not.toThrow();
  });
});
