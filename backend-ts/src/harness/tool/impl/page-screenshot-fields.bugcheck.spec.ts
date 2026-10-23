import { describe, expect, it, vi } from 'vitest';
import { createPageTools } from './page-tools.js';
import type { EmbedPageToolRegistry, PendingPageToolRequest } from '../../embed-page-tool-registry.js';

/**
 * Bugcheck：page_screenshot 压缩后回传的字段集（2026-10-23 审查 M-4，来自体积压缩方向）。
 *
 * page-tools.ts:146-154（PageScreenshotTool.executePageTool）：
 *   const compressed = await compressScreenshot(dataUri, mime);
 *   return toJson({
 *     media_type: 'image', mime, path, data_uri, width, height, masked,
 *   });
 *
 * 这里**新建**了一个只含 7 个键的对象，outcome 层（PageToolOutcome）的其它字段全部丢弃。
 * 对照 engine.ts:298-303：handleScreenshot 返回 { success, result: shot, pageVersion }，
 * handleSingle 还带 snapshotId / pageVersion。这些是上游 SDK 的产出，后端重建对象时
 * 一并丢掉，且无任何日志。
 *
 * 影响：桌面端 / SDK 后续在 result 或 outcome 上加字段（viewport、deviceScaleFactor、
 * pageVersion…）会被静默吞掉，模型与前端都看不到；排障时缺少页面版本信息。
 */

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

describe('page_screenshot 回传字段', () => {
  it('M-4：压缩路径重建对象，丢弃 outcome 层的 pageVersion 等字段', async () => {
    // engine.ts handleScreenshot 的真实返回形态：outcome 层带 pageVersion
    const { tools } = registryOf({
      success: true,
      result: {
        dataUri: 'data:image/png;base64,AAA',
        mime: 'image/png',
        width: 100,
        height: 50,
        masked: true,
      },
      pageVersion: 42,
    });
    const raw = await toolOf(tools, 'page_screenshot').execute('{}', 11, 7, null) as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // 期望：上游 outcome 的 pageVersion 透传给模型 / 前端
    // 实际：只有 7 个白名单键，pageVersion 静默丢失
    expect(parsed.pageVersion).toBe(42);
  });

  it('M-4：result 内非白名单字段同样被丢弃', async () => {
    const { tools } = registryOf({
      success: true,
      result: {
        dataUri: 'data:image/png;base64,AAA',
        mime: 'image/png',
        width: 100,
        height: 50,
        masked: true,
        // 假设上游后续扩展的字段
        deviceScaleFactor: 2,
        viewport: { width: 1280, height: 720 },
      },
    });
    const raw = await toolOf(tools, 'page_screenshot').execute('{}', 11, 7, null) as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.deviceScaleFactor).toBe(2);
    expect(parsed.viewport).toEqual({ width: 1280, height: 720 });
  })

  it('正确性基线：7 个白名单字段本身完整透传', async () => {
    const { tools } = registryOf({
      success: true,
      result: { dataUri: 'data:image/png;base64,AAA', mime: 'image/png', width: 100, height: 50, masked: true },
    });
    const raw = await toolOf(tools, 'page_screenshot').execute('{}', 11, 7, null) as string;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.media_type).toBe('image');
    expect(parsed.mime).toBe('image/png');
    expect(parsed.path).toBe('page-screenshot.png');
    expect(parsed.data_uri).toBe('data:image/png;base64,AAA');
    expect(parsed.width).toBe(100);
    expect(parsed.height).toBe(50);
    expect(parsed.masked).toBe(true);
  })

  it('正确性基线：非图片 / 失败结果原样返回，不进压缩分支', async () => {
    const failure = registryOf({ success: false, error: { code: 'screenshot_failed', message: 'boom' } });
    const raw = await toolOf(failure.tools, 'page_screenshot').execute('{}', 11, 7, null) as string;
    expect(JSON.parse(raw)).toEqual({ success: false, error: { code: 'screenshot_failed', message: 'boom' } });
  })
})
