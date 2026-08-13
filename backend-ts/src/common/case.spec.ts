import { describe, expect, it } from 'vitest';
import { camelToSnake, snakeToCamel, toCamel, toSnakeRow, hasText } from './case.js';

describe('case', () => {
  it('converts snake and camel', () => {
    expect(snakeToCamel('display_name')).toBe('displayName');
    expect(camelToSnake('displayName')).toBe('display_name');
    expect(toCamel({ display_name: 'a', id: 1 })).toEqual({ displayName: 'a', id: 1 });
    expect(toSnakeRow({ displayName: 'a', skip: undefined })).toEqual({ display_name: 'a' });
    expect(hasText('  x ')).toBe(true);
    expect(hasText('  ')).toBe(false);
    expect(toCamel(null)).toBeNull();
  });
});
