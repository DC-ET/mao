import { describe, expect, it } from 'vitest';
import { permissionLevelFromString } from './permission-level.js';

describe('permissionLevelFromString', () => {
  it('parses all five levels', () => {
    expect(permissionLevelFromString('READ_ONLY')).toBe('READ_ONLY');
    expect(permissionLevelFromString('READ_WRITE')).toBe('READ_WRITE');
    expect(permissionLevelFromString('SMART')).toBe('SMART');
    expect(permissionLevelFromString('PROXY')).toBe('PROXY');
    expect(permissionLevelFromString('FULL')).toBe('FULL');
  });

  it('falls back to READ_ONLY for null/undefined/unknown', () => {
    expect(permissionLevelFromString(null)).toBe('READ_ONLY');
    expect(permissionLevelFromString(undefined)).toBe('READ_ONLY');
    expect(permissionLevelFromString('')).toBe('READ_ONLY');
    expect(permissionLevelFromString('proxy')).toBe('READ_ONLY');
    expect(permissionLevelFromString('WHATEVER')).toBe('READ_ONLY');
  });
});
