import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageEngine } from './engine';
import type { PageConfirmRequest } from './authorization';

const originalRect = Element.prototype.getBoundingClientRect;
let engine: PageEngine;
let confirmRequests: PageConfirmRequest[];
let logs: string[];
let highlights: Array<{ elementId: string } | null>;

function buildEngine(identity = 'u1', sessionId = 1): PageEngine {
  return new PageEngine({
    serverUrl: 'https://mao.example.com',
    agentId: 7,
    identity: () => identity,
    currentSessionId: () => sessionId,
    onConfirmRequest: (request) => { if (request) confirmRequests.push(request); },
    onLog: (entry) => { logs.push(`${entry.status}:${entry.summary}`); },
    onHighlight: (target) => { highlights.push(target); },
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  Element.prototype.getBoundingClientRect = function stubRect() {
    return { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) } as DOMRect;
  };
  confirmRequests = [];
  logs = [];
  highlights = [];
  engine = buildEngine();
});

afterEach(() => {
  engine.destroy();
  Element.prototype.getBoundingClientRect = originalRect;
  document.body.innerHTML = '';
});

describe('PageEngine', () => {
  it('returns a page snapshot for page_inspect', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const outcome = await engine.handleRequest('page_inspect', {}, 1);
    expect(outcome.success).toBe(true);
    expect(outcome.snapshotId).toBeTruthy();
    expect((outcome.result as { elements: unknown[] }).elements).toHaveLength(1);
  });

  it('requires per-action confirmation and executes when approved', async () => {
    document.body.innerHTML = '<button id="b">保存</button>';
    document.getElementById('b')!.addEventListener('click', () => { document.body.dataset.clicked = '1'; });
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const pending = engine.handleRequest('page_click', { snapshotId: inspect.snapshotId, elementId: 'e1' }, 1);
    await Promise.resolve();
    expect(confirmRequests).toHaveLength(1);
    expect(highlights.some((h) => h?.elementId === 'e1')).toBe(true);
    engine.resolveConfirmation(confirmRequests[0]!.id, true);
    const outcome = await pending;
    expect(outcome.success).toBe(true);
    expect(document.body.dataset.clicked).toBe('1');
  });

  it('denies execution when the user rejects the confirmation', async () => {
    document.body.innerHTML = '<button>保存</button>';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const pending = engine.handleRequest('page_click', { snapshotId: inspect.snapshotId, elementId: 'e1' }, 1);
    await Promise.resolve();
    engine.resolveConfirmation(confirmRequests[0]!.id, false);
    const outcome = await pending;
    expect(outcome.success).toBe(false);
    expect(outcome.error!.code).toBe('authorization_denied');
  });

  it('ignores requests for a different session', async () => {
    engine = buildEngine('u1', 99);
    const outcome = await engine.handleRequest('page_inspect', {}, 1);
    expect(outcome.success).toBe(false);
  });

  it('executes a batch and stops at failure', async () => {
    document.body.innerHTML = '<input id="a"><button>保存</button>';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    engine.setLevel('full', 1);
    const outcome = await engine.handleRequest('page_actions', {
      snapshotId: inspect.snapshotId,
      actions: [
        { type: 'fill', elementId: 'e1', value: 'ok' },
        { type: 'fill', elementId: 'e2', value: 'nope' },
      ],
    }, 1);
    expect(outcome.success).toBe(false);
    const batch = outcome.result as { steps: unknown[]; stoppedAt?: number };
    expect(batch.steps).toHaveLength(2);
    expect(batch.stoppedAt).toBe(1);
  });

  it('logs click and fill with the target name, not a bare verb', async () => {
    document.body.innerHTML = '<input aria-label="筛选条件"><button>保存</button>';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    engine.setLevel('full', 1);
    await engine.handleRequest('page_fill', { snapshotId: inspect.snapshotId, elementId: 'e1', value: '核心表' }, 1);
    await engine.handleRequest('page_click', { snapshotId: inspect.snapshotId, elementId: 'e2' }, 1);
    expect(logs).toContain('success:填写「筛选条件」为 核心表');
    expect(logs).toContain('success:点击「保存」');
  });

  it('observes page changes and waits for stability', async () => {
    document.body.innerHTML = '<button>A</button>';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    document.body.innerHTML = '<button>A</button><button>B</button>';
    const observed = await engine.handleRequest('page_observe', { snapshotId: inspect.snapshotId }, 1);
    expect((observed.result as { elementCount: number }).elementCount).toBe(2);
    const waited = await engine.handleRequest('page_wait', { ms: 1 }, 1);
    expect(waited.success).toBe(true);
  });

  it('captures a masked screenshot through the injected renderer', async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    await engine.handleRequest('page_inspect', {}, 1);
    const renderer = vi.fn(async () => ({
      width: 100, height: 50,
      getContext: () => null,
      toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement));
    engine = new PageEngine({
      serverUrl: 'https://mao.example.com', agentId: 7, identity: () => 'u1', currentSessionId: () => 1,
      screenshotRenderer: renderer, onConfirmRequest: (r) => { if (r) confirmRequests.push(r); },
    });
    await engine.handleRequest('page_inspect', {}, 1);
    const outcome = await engine.handleRequest('page_screenshot', {}, 1);
    expect(outcome.success).toBe(true);
    const shot = outcome.result as { masked: boolean; mime: string; dataUri: string };
    expect(shot.masked).toBe(true);
    expect(shot.mime).toBe('image/png');
    expect(shot.dataUri.startsWith('data:image/png')).toBe(true);
  });

  it('allows an unmasked screenshot within task authorization without confirmation', async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    const renderer = vi.fn(async () => ({
      width: 100, height: 50,
      getContext: () => null,
      toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement));
    engine = new PageEngine({
      serverUrl: 'https://mao.example.com', agentId: 7, identity: () => 'u1', currentSessionId: () => 1,
      screenshotRenderer: renderer, onConfirmRequest: (r) => { if (r) confirmRequests.push(r); },
    });
    engine.setLevel('task', 1);
    const outcome = await engine.handleRequest('page_screenshot', { maskSensitive: false }, 1);
    expect(outcome.success).toBe(true);
    expect(confirmRequests).toHaveLength(0);
    expect((outcome.result as { masked: boolean }).masked).toBe(false);
  });

  it('still confirms an unmasked screenshot under per_action authorization', async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    const renderer = vi.fn(async () => ({
      width: 100, height: 50,
      getContext: () => null,
      toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement));
    engine = new PageEngine({
      serverUrl: 'https://mao.example.com', agentId: 7, identity: () => 'u1', currentSessionId: () => 1,
      screenshotRenderer: renderer, onConfirmRequest: (r) => { if (r) confirmRequests.push(r); },
    });
    const pending = engine.handleRequest('page_screenshot', { maskSensitive: false }, 1);
    await Promise.resolve();
    expect(confirmRequests).toHaveLength(1);
    engine.resolveConfirmation(confirmRequests[0]!.id, true);
    const outcome = await pending;
    expect(outcome.success).toBe(true);
    expect((outcome.result as { masked: boolean }).masked).toBe(false);
  });

  it('masks sensitive fields even without a prior inspect', async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    const fillRect = vi.fn();
    const renderer = vi.fn(async () => ({
      width: 100, height: 50,
      getContext: () => ({ fillRect, fillStyle: '' }),
      toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
    } as unknown as HTMLCanvasElement));
    engine = new PageEngine({
      serverUrl: 'https://mao.example.com', agentId: 7, identity: () => 'u1', currentSessionId: () => 1,
      screenshotRenderer: renderer,
    });
    const outcome = await engine.handleRequest('page_screenshot', {}, 1);
    expect(outcome.success).toBe(true);
    expect((outcome.result as { masked: boolean }).masked).toBe(true);
    expect(fillRect).toHaveBeenCalled();
  });

  it('redacts sensitive values in per_action and allows them after full authorization', async () => {
    document.body.innerHTML = '<input type="password" value="secret">';
    const redacted = await engine.handleRequest('page_inspect', {}, 1);
    const first = (redacted.result as { elements: Array<{ value: unknown }> }).elements[0]!;
    expect(first.value).toBe('[REDACTED]');
    engine.setLevel('full', 1);
    const plain = await engine.handleRequest('page_inspect', {}, 1);
    const second = (plain.result as { elements: Array<{ value: unknown }> }).elements[0]!;
    expect(second.value).toBe('secret');
  });

  it('flags truncated batches over the per-call limit', async () => {
    document.body.innerHTML = '<button>保存</button>';
    engine.setLevel('full', 1);
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const actions = Array.from({ length: 51 }, () => ({ type: 'wait', ms: 0 }));
    const outcome = await engine.handleRequest('page_actions', { snapshotId: inspect.snapshotId, actions }, 1);
    expect((outcome.result as { truncated?: boolean }).truncated).toBe(true);
  });

  it('coerces numeric fill values in single and batch actions', async () => {
    document.body.innerHTML = '<input id="n">';
    engine.setLevel('full', 1);
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const single = await engine.handleRequest('page_fill', { snapshotId: inspect.snapshotId, elementId: 'e1', value: 123 }, 1);
    expect(single.success).toBe(true);
    expect((document.getElementById('n') as HTMLInputElement).value).toBe('123');
    const batch = await engine.handleRequest('page_actions', {
      snapshotId: inspect.snapshotId,
      actions: [{ type: 'fill', elementId: 'e1', value: 456 }],
    }, 1);
    expect(batch.success).toBe(true);
    expect((document.getElementById('n') as HTMLInputElement).value).toBe('456');
  });

  it('downgrades host-provided full authorization but allows the in-panel user path', () => {
    engine.setHostLevel('full', 1);
    expect(engine.authorizationLevel).toBe('per_action');
    engine.setLevel('full', 1);
    expect(engine.authorizationLevel).toBe('full');
  });

  it('does not let the host API clear a user-granted full authorization', () => {
    engine.setLevel('full', 1);
    engine.setHostLevel('full', 1);
    expect(engine.authorizationLevel).toBe('full');
  });

  it('revokes task authorization at task end even without a page request', () => {
    engine.setLevel('task', 1);
    expect(engine.authorizationLevel).toBe('task');
    engine.endTask();
    expect(engine.authorizationLevel).toBe('per_action');
  });

  it('stops a per_action batch after the first confirmed action', async () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const pending = engine.handleRequest('page_actions', {
      snapshotId: inspect.snapshotId,
      actions: [
        { type: 'fill', elementId: 'e1', value: 'x' },
        { type: 'fill', elementId: 'e2', value: 'y' },
      ],
    }, 1);
    await Promise.resolve();
    engine.resolveConfirmation(confirmRequests[0]!.id, true);
    const outcome = await pending;
    const batch = outcome.result as { steps: unknown[]; stoppedAt?: number; reason?: string };
    expect(batch.steps).toHaveLength(1);
    expect(batch.stoppedAt).toBe(0);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('x');
    expect((document.getElementById('b') as HTMLInputElement).value).toBe('');
  });

  it('aborts an in-flight batch on disconnect but still allows the next request', async () => {
    document.body.innerHTML = '<input id="a">';
    engine.setLevel('full', 1);
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const pending = engine.handleRequest('page_actions', {
      snapshotId: inspect.snapshotId,
      actions: [
        { type: 'wait', ms: 100 },
        { type: 'fill', elementId: 'e1', value: 'x' },
      ],
    }, 1);
    await Promise.resolve();
    engine.abortInFlight();
    const outcome = await pending;
    const batch = outcome.result as { steps: Array<{ success: boolean }>; stoppedAt?: number; reason?: string };
    expect(batch.steps).toHaveLength(1);
    expect(batch.steps[0]!.success).toBe(false);
    expect(batch.stoppedAt).toBe(0);
    expect((document.getElementById('a') as HTMLInputElement).value).toBe('');
    // 断线中止不应永久阻断后续任务：重连后的新请求可正常执行
    const after = await engine.handleRequest('page_inspect', {}, 1);
    expect(after.success).toBe(true);
  });

  it('rejects a waiting confirmation on disconnect', async () => {
    document.body.innerHTML = '<button id="b">保存</button>';
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    const pending = engine.handleRequest('page_click', { snapshotId: inspect.snapshotId, elementId: 'e1' }, 1);
    await Promise.resolve();
    expect(confirmRequests).toHaveLength(1);
    engine.abortInFlight();
    const outcome = await pending;
    expect(outcome.success).toBe(false);
    expect(outcome.error!.code).toBe('authorization_denied');
  });

  it('passes sensitive elements to the renderer for content-level masking', async () => {
    document.body.innerHTML = '<input type="password"><button>保存</button>';
    let masked: Element[] = [];
    const renderer = vi.fn(async (root: HTMLElement, options: { mask?: (el: Element) => boolean }) => {
      masked = [root, ...Array.from(root.querySelectorAll('*'))].filter((el) => options.mask?.(el));
      return {
        width: 100, height: 50, getContext: () => null,
        toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['png'], { type: 'image/png' })),
      } as unknown as HTMLCanvasElement;
    });
    engine = new PageEngine({
      serverUrl: 'https://mao.example.com', agentId: 7, identity: () => 'u1', currentSessionId: () => 1,
      screenshotRenderer: renderer,
    });
    const outcome = await engine.handleRequest('page_screenshot', {}, 1);
    expect(outcome.success).toBe(true);
    expect(masked.some((el) => el instanceof HTMLInputElement && el.type === 'password')).toBe(true);
  });

  it('keeps the snapshot from inspect when the host executes an action', async () => {
    document.body.innerHTML = '<input id="h">';
    engine.setLevel('full', 1);
    const snapshot = engine.inspect({ sessionId: 1 });
    const result = await engine.executeAction({ type: 'fill', elementId: 'e1', value: 'v' }, snapshot.snapshotId, 1);
    expect(result.success).toBe(true);
    expect((document.getElementById('h') as HTMLInputElement).value).toBe('v');
  });

  it('rejects backend requests after cancel until a new task is prepared', async () => {
    document.body.innerHTML = '<button>保存</button>';
    engine.cancel();
    const cancelled = await engine.handleRequest('page_inspect', {}, 1);
    expect(cancelled.success).toBe(false);
    expect(cancelled.error!.code).toBe('task_cancelled');
    engine.prepareNewTask();
    const after = await engine.handleRequest('page_inspect', {}, 1);
    expect(after.success).toBe(true);
  });

  it('logs executed actions', async () => {
    document.body.innerHTML = '<button>保存</button>';
    engine.setLevel('full', 1);
    const inspect = await engine.handleRequest('page_inspect', {}, 1);
    await engine.handleRequest('page_click', { snapshotId: inspect.snapshotId, elementId: 'e1' }, 1);
    expect(logs.some((entry) => entry.startsWith('success:'))).toBe(true);
  });
});
