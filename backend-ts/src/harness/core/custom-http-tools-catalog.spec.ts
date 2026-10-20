import { describe, expect, it } from 'vitest';
import { buildCustomHttpToolCatalog } from './custom-http-tools-catalog.js';
import type { UserTool } from '../../user-tool/types.js';

function tool(overrides: Partial<UserTool> = {}): UserTool {
  return {
    id: 1,
    userId: 7,
    name: 'weather',
    displayName: '天气查询',
    description: '查询城市天气',
    method: 'GET',
    url: 'https://api.example.com/v1/weather',
    headersJson: null,
    bodyTemplate: null,
    readOnly: 1,
    timeoutMs: 15000,
    enabled: 1,
    ...overrides,
  };
}

describe('buildCustomHttpToolCatalog', () => {
  it('sorts by name ASC and maps display fields', () => {
    const catalog = buildCustomHttpToolCatalog([
      tool({ id: 2, name: 'weather' }),
      tool({ id: 3, name: 'alerts' }),
    ], 20);
    expect(catalog.tools.map((item) => item.name)).toEqual(['alerts', 'weather']);
    expect(catalog.tools[0]).toEqual({
      name: 'alerts', displayName: '天气查询', method: 'GET', readOnly: true, description: '查询城市天气',
    });
    expect(catalog.hiddenCount).toBe(0);
  });

  it('truncates the description to the catalog budget', () => {
    const catalog = buildCustomHttpToolCatalog([tool({ description: 'x'.repeat(500) })], 20);
    expect(catalog.tools[0]!.description).toHaveLength(200);
  });

  it('slices to the enabled cap and counts the hidden remainder', () => {
    const catalog = buildCustomHttpToolCatalog([
      tool({ id: 1, name: 'c' }), tool({ id: 2, name: 'a' }), tool({ id: 3, name: 'b' }),
    ], 2);
    expect(catalog.tools.map((item) => item.name)).toEqual(['a', 'b']);
    expect(catalog.hiddenCount).toBe(1);
  });

  it('returns an empty catalog for an empty list (caller skips the section)', () => {
    expect(buildCustomHttpToolCatalog([], 20)).toEqual({ tools: [], hiddenCount: 0 });
  });

  it('treats a non-positive cap as nothing loadable', () => {
    const catalog = buildCustomHttpToolCatalog([tool()], 0);
    expect(catalog.tools).toHaveLength(0);
    expect(catalog.hiddenCount).toBe(1);
  });

  it('does not mutate the input array order', () => {
    const input = [tool({ id: 2, name: 'z' }), tool({ id: 1, name: 'a' })];
    buildCustomHttpToolCatalog(input, 20);
    expect(input.map((item) => item.name)).toEqual(['z', 'a']);
  });
});
