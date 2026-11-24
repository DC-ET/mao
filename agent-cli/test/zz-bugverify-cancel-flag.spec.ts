/**
 * 回归用例（第六轮逻辑 BUG 审查锚点转正，BUG-6）：
 * session-runner.ts handleAlreadyActive 的 printMode + ifRunning='cancel' 分支曾无条件
 *   await this.sendCancel();
 *   await this.waitUntilSettled(CANCEL_WAIT_MS);
 *   this.resetRound();          // ← 把 cancelledByUserFlag 清成 false
 * 而紧邻的 wait 分支有守卫：if (!this.timedOutFlag && !this.cancelledByUserFlag) this.resetRound();
 * runPrompt:160 的 `if (this.cancelledByUserFlag || this.timedOutFlag) return this.buildResult()`
 * 因此被绕过 → 落到重试循环 → sendMessage 把用户 Ctrl+C 掉的那条消息原样发给服务端。
 * 已修复：cancel 分支补上与 wait 分支相同的守卫。
 *
 * 本用例断言「正确行为」：等待占用者期间用户按下 Ctrl+C（cancel() 置位旗标）后，
 * 本轮必须直接结束，不得再发送任何 send_message。
 * 对照组：同形态的 wait 分支有守卫、行为正确，证明这是漏加而非设计。
 */
import { describe, expect, it } from 'vitest';

import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { Renderer } from '../src/render/types';
import type { SessionVO } from '../src/rest/types';
import type { WsEvent } from '../src/ws/event-types';

class FakeWs {
  handlers: Array<(e: WsEvent) => void> = [];
  sent: object[] = [];
  closed = false;
  snapshot: WsEvent;

  constructor(snapshot: WsEvent) {
    this.snapshot = snapshot;
  }

  async connect(): Promise<void> { /* open */ }
  subscribe(): void {
    this.emit(this.snapshot);
  }
  unsubscribe(): void { /* noop */ }
  send(payload: object): void { this.sent.push(payload); }
  async sendReliable(payload: object): Promise<boolean> {
    this.sent.push(payload);
    return true;
  }
  close(): void { this.closed = true; }
  on(handler: (e: WsEvent) => void): () => void {
    this.handlers.push(handler);
    return () => undefined;
  }
  emit(evt: WsEvent): void {
    for (const h of this.handlers) h(evt);
  }
}

function restStub(): RestClient {
  return { createSession: async () => ({ id: 11, phase: 'RUNNING' }) } as unknown as RestClient;
}

function rendererStub(): Renderer {
  return { onEvent: () => undefined } as unknown as Renderer;
}

function session(): SessionVO {
  return { id: 11, phase: 'RUNNING', agentName: 'a', modelName: 'm' };
}

function makeRunner(ws: FakeWs, ifRunning: 'wait' | 'cancel' | 'fail'): SessionRunner {
  return new SessionRunner({
    rest: restStub(),
    ws: ws as unknown as WsClient,
    renderer: rendererStub(),
    printMode: true,
    ifRunning,
    onQuestion: 'fail',
    includeToolIo: true,
  } as never);
}

const tick = () => new Promise((r) => setTimeout(r, 10));

function runningSnapshot(): WsEvent {
  return { type: 'session_snapshot', sessionId: 11, data: { phase: 'RUNNING', executionId: 'occ-1' } };
}

function sends(ws: FakeWs): Array<{ type: string }> {
  return ws.sent.filter((m) => (m as { type: string }).type === 'send_message') as Array<{ type: string }>;
}

describe('print 模式 --if-running=cancel 期间用户 Ctrl+C（回归）', () => {
  it('取消占用者后用户又按 Ctrl+C：本轮必须结束且不得再发送消息', async () => {
    const ws = new FakeWs(runningSnapshot());
    const runner = makeRunner(ws, 'cancel');
    await runner.attach(session());

    const p = runner.runPrompt('hello');
    await tick();
    // handleAlreadyActive 已向占用者发出 cancel，正在 waitUntilSettled 等待其终态
    expect(ws.sent.some((m) => (m as { type: string }).type === 'cancel')).toBe(true);

    await runner.cancel(); // 模拟 Ctrl+C：chat.ts onSig → runner.cancel()
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'CANCELLED', executionId: 'occ-1' } });
    await tick();

    // 正确行为：用户已取消，本轮直接收尾，不得把 'hello' 发给服务端
    expect(sends(ws)).toHaveLength(0);
    const result = await p;
    expect(result.status).toBe('CANCELLED');
  });

  it('对照组：无 Ctrl+C 时按既定语义发取消并继续执行自己的消息（既有行为正确）', async () => {
    const ws = new FakeWs(runningSnapshot());
    const runner = makeRunner(ws, 'cancel');
    await runner.attach(session());

    const p = runner.runPrompt('hello');
    await tick();
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'CANCELLED', executionId: 'occ-1' } });
    await tick();
    expect(sends(ws)).toHaveLength(1); // 占用者被取消后照常发送自己的消息

    const eid = (sends(ws)[0] as unknown as { data: { eventId: string } }).data.eventId;
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'COMPLETED', executionId: eid } });
    expect((await p).status).toBe('COMPLETED');
  });

  it('对照组：wait 分支同一时序有守卫，Ctrl+C 后不会重发（证明对称兜底是既定口径）', async () => {
    const ws = new FakeWs(runningSnapshot());
    const runner = makeRunner(ws, 'wait');
    await runner.attach(session());

    const p = runner.runPrompt('hello');
    await tick();
    await runner.cancel();
    ws.emit({ type: 'session_status', sessionId: 11, data: { phase: 'COMPLETED', executionId: 'occ-1' } });
    await tick();
    // 关键差异点：wait 分支有 cancelledByUserFlag 守卫，Ctrl+C 后不会把消息发出去
    expect(sends(ws)).toHaveLength(0);
    await p;
  });
});
