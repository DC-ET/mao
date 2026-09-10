import { describe, expect, it, vi } from 'vitest';
import { createPageTools } from './page-tools.js';
import type { EmbedPageToolRegistry, PendingPageToolRequest } from '../../embed-page-tool-registry.js';

function registryOf(result: unknown): { request: ReturnType<typeof vi.fn>; tools: ReturnType<typeof createPageTools> } {
  const request = vi.fn(async (): Promise<PendingPageToolRequest> => ({
    requestId: 'req-1', future: Promise.resolve(JSON.stringify(result)),
  }));
  const tools = createPageTools({ request } as unknown as EmbedPageToolRegistry);
  return { request, tools };
}

function toolOf(tools: ReturnType<typeof createPageTools>, name: string) {
  const tool = tools.find((t) => t.getName() === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('page tools', () => {
  it('registers the full page tool set', () => {
    const { tools } = registryOf({ success: true });
    expect(tools.map((t) => t.getName()).sort()).toEqual([
      'page_actions', 'page_check', 'page_click', 'page_fill', 'page_focus', 'page_inspect',
      'page_keyboard', 'page_observe', 'page_screenshot', 'page_scroll', 'page_select', 'page_uncheck', 'page_wait',
    ]);
  });

  it('rejects selector / xpath / script arguments before reaching the SDK', async () => {
    const { request, tools } = registryOf({ success: true });
    const result = JSON.parse(await toolOf(tools, 'page_click').execute(
      JSON.stringify({ snapshotId: 's1', elementId: 'e1', selector: '#x' }), 11, 7, null,
    ) as string) as { error: { code: string } };
    expect(result.error.code).toBe('invalid_arguments');
    expect(request).not.toHaveBeenCalled();
  });

  it('requires element references for element actions', async () => {
    const { request, tools } = registryOf({ success: true });
    const result = JSON.parse(await toolOf(tools, 'page_fill').execute(
      JSON.stringify({ snapshotId: 's1', value: 'x' }), 11, 7, null,
    ) as string) as { error: { code: string } };
    expect(result.error.code).toBe('invalid_arguments');
    expect(request).not.toHaveBeenCalled();
  });

  it('forwards validated arguments to the page registry and returns the raw result', async () => {
    const { request, tools } = registryOf({ success: true, result: { snapshotId: 's1' } });
    const raw = await toolOf(tools, 'page_click').execute(
      JSON.stringify({ snapshotId: 's1', elementId: 'e1' }), 11, 7, null,
    ) as string;
    expect(request).toHaveBeenCalledWith(11, 'page_click', { snapshotId: 's1', elementId: 'e1' });
    expect(JSON.parse(raw).success).toBe(true);
  });

  it('rejects calls without a session', async () => {
    const { tools } = registryOf({ success: true });
    const result = JSON.parse(await toolOf(tools, 'page_inspect').execute('{}', null, null, null) as string) as { error: { code: string } };
    expect(result.error.code).toBe('invalid_arguments');
  });

  it('wraps screenshots as image tool results for vision models', async () => {
    const { tools } = registryOf({
      success: true,
      result: { dataUri: 'data:image/png;base64,AAA', mime: 'image/png', width: 100, height: 50, masked: true },
    });
    const raw = await toolOf(tools, 'page_screenshot').execute('{}', 11, 7, null) as string;
    const parsed = JSON.parse(raw) as { media_type: string; data_uri: string; masked: boolean };
    expect(parsed.media_type).toBe('image');
    expect(parsed.data_uri).toBe('data:image/png;base64,AAA');
    expect(parsed.masked).toBe(true);
  });

  it('describes remote-search dropdown usage on fill and select tools', () => {
    const { tools } = registryOf({ success: true });
    expect(toolOf(tools, 'page_fill').getDescription()).toContain('远程搜索');
    expect(toolOf(tools, 'page_select').getDescription()).toContain('原生 HTML select');
    expect(toolOf(tools, 'page_inspect').getDescription()).toContain('下拉建议');
  });
});
