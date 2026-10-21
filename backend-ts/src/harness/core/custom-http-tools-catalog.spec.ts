import { describe, expect, it } from 'vitest';
import { buildCustomHttpToolCatalog } from './custom-http-tools-catalog.js';
import type { HttpTool } from '../../http-tool/types.js';

function tool(overrides: Partial<HttpTool> = {}): HttpTool {
  return {
    id: 1,
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
    ]);
    expect(catalog.tools.map((item) => item.name)).toEqual(['alerts', 'weather']);
    expect(catalog.tools[0]).toEqual({
      name: 'alerts', displayName: '天气查询', method: 'GET', readOnly: true, description: '查询城市天气',
    });
  });

  it('truncates the description to the catalog budget', () => {
    const catalog = buildCustomHttpToolCatalog([tool({ description: 'x'.repeat(500) })]);
    expect(catalog.tools[0]!.description).toHaveLength(200);
  });

  it('loads every associated tool (no enabled cap after the agent-scoped pivot)', () => {
    const catalog = buildCustomHttpToolCatalog([
      tool({ id: 1, name: 'c' }), tool({ id: 2, name: 'a' }), tool({ id: 3, name: 'b' }),
    ]);
    expect(catalog.tools.map((item) => item.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty catalog for an empty list (caller skips the section)', () => {
    expect(buildCustomHttpToolCatalog([])).toEqual({ tools: [] });
  });

  it('does not mutate the input array order', () => {
    const input = [tool({ id: 2, name: 'z' }), tool({ id: 1, name: 'a' })];
    buildCustomHttpToolCatalog(input);
    expect(input.map((item) => item.name)).toEqual(['z', 'a']);
  });
});
