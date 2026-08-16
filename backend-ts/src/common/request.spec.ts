import { describe, expect, it } from 'vitest';
import { collectEntityIds, idMapGet, parseEntityId } from './request.js';

describe('parseEntityId', () => {
  it('coerces numeric strings like Java Long deserialization', () => {
    expect(parseEntityId('9')).toBe(9);
    expect(parseEntityId(9)).toBe(9);
    expect(parseEntityId(null)).toBeNull();
    expect(parseEntityId('')).toBeNull();
    expect(parseEntityId('x')).toBeNull();
  });

  it('collects unique numeric ids and looks them up in maps', () => {
    expect(collectEntityIds(['9', 9, null, 'x'])).toEqual([9]);
    const map = new Map([[9, { name: 'Coder' }]]);
    expect(idMapGet(map, '9')?.name).toBe('Coder');
    expect(idMapGet(map, 9)?.name).toBe('Coder');
    expect(idMapGet(map, '8')).toBeUndefined();
  });
});
