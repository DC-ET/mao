import { describe, expect, it, vi } from 'vitest';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';
import { EmbedPageToolRegistry, resolveEmbedPageToolTimeoutMs, DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS } from './embed-page-tool-registry.js';

function socket(id: string): WsSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    id, readyState: WS_OPEN, sent,
    send: (data: string) => { sent.push(data); },
    close: vi.fn(),
  };
}

function setup() {
  const registry = new StreamingWsRegistry();
  const pageTools = new EmbedPageToolRegistry(registry, 40);
  return { registry, pageTools };
}

describe('EmbedPageToolRegistry', () => {
  it('converts the seconds-based config into milliseconds', () => {
    expect(resolveEmbedPageToolTimeoutMs(180)).toBe(180_000);
    expect(resolveEmbedPageToolTimeoutMs(0.5)).toBe(500);
    expect(resolveEmbedPageToolTimeoutMs(undefined)).toBe(DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS * 1000);
    expect(resolveEmbedPageToolTimeoutMs(0)).toBe(DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS * 1000);
    expect(resolveEmbedPageToolTimeoutMs(Number.NaN)).toBe(DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS * 1000);
  });

  it('refuses requests for sessions without an embed binding', async () => {
    const { pageTools } = setup();
    const pending = await pageTools.request(11, 'page_inspect', {});
    expect(pending.requestId).toBeNull();
    const outcome = JSON.parse(await pending.future) as { success: boolean; error: { code: string } };
    expect(outcome.success).toBe(false);
    expect(outcome.error.code).toBe('embed_session_required');
  });

  it('routes requests only to the bound connection and completes from that connection', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    const other = socket('embed-other');
    registry.register(bound, 7, 'embed');
    registry.register(other, 7, 'embed');
    registry.bindEmbedSession(11, bound);

    const { requestId, future } = await pageTools.request(11, 'page_click', { elementId: 'e1' });
    expect(requestId).toBeTruthy();
    expect(bound.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
    const frame = JSON.parse(bound.sent[0]!) as { type: string; data: { requestId: string; tool: string } };
    expect(frame.type).toBe('page_tool_request');
    expect(frame.data.tool).toBe('page_click');

    // 非绑定连接的回包不能完成请求
    expect(pageTools.complete(11, requestId!, other, { success: true, result: 'spoofed' })).toBe(false);
    expect(pageTools.pendingCount(11)).toBe(1);
    // 绑定连接的回包完成请求，并保留结构化字段
    expect(pageTools.complete(11, requestId!, bound, {
      success: true, result: { ok: true }, snapshotId: 'snap-1', pageVersion: 'v2',
    })).toBe(true);
    const outcome = JSON.parse(await future) as { success: boolean; snapshotId: string; pageVersion: string };
    expect(outcome.success).toBe(true);
    expect(outcome.snapshotId).toBe('snap-1');
    expect(outcome.pageVersion).toBe('v2');
    // 重复回包被忽略
    expect(pageTools.complete(11, requestId!, bound, { success: true })).toBe(false);
  });

  it('serializes requests per session and dispatches the next after the previous completes', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    registry.register(bound, 7, 'embed');
    registry.bindEmbedSession(11, bound);
    const first = await pageTools.request(11, 'page_fill', { step: 1 });
    const second = await pageTools.request(11, 'page_fill', { step: 2 });
    // 第二个请求排队，不立即下发，避免并发确认耗尽后端超时
    expect(bound.sent).toHaveLength(1);
    expect(pageTools.pendingCount(11)).toBe(2);
    expect(pageTools.complete(11, first.requestId!, bound, { success: true, result: {} })).toBe(true);
    await first.future;
    expect(bound.sent).toHaveLength(2);
    const secondFrame = JSON.parse(bound.sent[1]!) as { data: { requestId: string } };
    expect(secondFrame.data.requestId).toBe(second.requestId);
    pageTools.complete(11, second.requestId!, bound, { success: true, result: {} });
    await second.future;
    expect(pageTools.pendingCount(11)).toBe(0);
  });

  it('fails queued requests when the session is cancelled', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    registry.register(bound, 7, 'embed');
    registry.bindEmbedSession(11, bound);
    const first = await pageTools.request(11, 'page_fill', { step: 1 });
    const second = await pageTools.request(11, 'page_fill', { step: 2 });
    pageTools.failSession(11, 'cancelled');
    const firstOutcome = JSON.parse(await first.future) as { error: { code: string } };
    const secondOutcome = JSON.parse(await second.future) as { error: { code: string } };
    expect(firstOutcome.error.code).toBe('task_cancelled');
    expect(secondOutcome.error.code).toBe('task_cancelled');
    expect(pageTools.pendingCount()).toBe(0);
  });

  it('fails pending requests on timeout', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    registry.register(bound, 7, 'embed');
    registry.bindEmbedSession(11, bound);
    const { future } = await pageTools.request(11, 'page_inspect', {});
    const outcome = JSON.parse(await future) as { success: boolean; error: { code: string } };
    expect(outcome.success).toBe(false);
    expect(outcome.error.code).toBe('page_tool_timeout');
  });

  it('fails pending requests when the session is cancelled or disconnected', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    registry.register(bound, 7, 'embed');
    registry.bindEmbedSession(11, bound);
    const first = await pageTools.request(11, 'page_inspect', {});
    pageTools.failSession(11, 'cancelled');
    const outcome = JSON.parse(await first.future) as { error: { code: string; message: string } };
    expect(outcome.error.code).toBe('task_cancelled');
    expect(outcome.error.message).toBe('cancelled');
    expect(pageTools.pendingCount()).toBe(0);

    // 解绑后不再接受请求
    registry.unbindEmbedSession(11, bound);
    expect(pageTools.isEmbedSession(11)).toBe(false);
  });

  it('does not leak pending state between LOCAL and page requests', async () => {
    const { registry, pageTools } = setup();
    const bound = socket('embed-bound');
    registry.register(bound, 7, 'embed');
    registry.bindEmbedSession(11, bound);
    const { requestId } = await pageTools.request(11, 'page_inspect', {});
    // 未知 requestId 不消费
    expect(pageTools.complete(11, 'local-request-id', bound, { success: true })).toBe(false);
    expect(pageTools.pendingCount(11)).toBe(1);
    expect(pageTools.complete(11, requestId!, bound, { success: true, result: {} })).toBe(true);
  });
});
