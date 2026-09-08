import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageAuthorization } from './authorization';

function makeAuth(identity: string | null, onChange?: (level: string, task: number | null) => void) {
  return new PageAuthorization({
    serverUrl: 'https://mao.example.com',
    agentId: 7,
    scopeVersion: 'v1',
    identity: () => identity,
    onStateChange: onChange,
    onConfirmRequest: undefined,
  });
}

beforeEach(() => { localStorage.clear(); });

describe('PageAuthorization', () => {
  it('defaults to per_action and requires confirmation for mutating actions', () => {
    const auth = makeAuth('u1');
    expect(auth.current).toBe('per_action');
    const click = auth.decide('page_click', 1, { type: 'click', elementId: 'e1' });
    expect(click.allowed).toBe(true);
    expect(click.needsConfirmation).toBe(true);
    const inspect = auth.decide('page_inspect', 1);
    expect(inspect.needsConfirmation).toBe(false);
  });

  it('persists full authorization per identity and revokes it', () => {
    const auth = makeAuth('u1');
    auth.setLevel('full');
    expect(auth.current).toBe('full');
    expect(makeAuth('u1').current).toBe('full');
    expect(makeAuth('u2').current).toBe('per_action');
    auth.revoke();
    expect(makeAuth('u1').current).toBe('per_action');
  });

  it('binds task authorization to the current session and drops it on task end', () => {
    const auth = makeAuth('u1');
    auth.setLevel('task', 42);
    expect(auth.current).toBe('task');
    expect(auth.decide('page_click', 42, { type: 'click', elementId: 'e1' }).allowed).toBe(true);
    expect(auth.decide('page_click', 43, { type: 'click', elementId: 'e1' }).error!.code).toBe('authorization_required');
    auth.endTask();
    expect(auth.current).toBe('per_action');
  });

  it('does not accept task level without a session', () => {
    const auth = makeAuth('u1');
    auth.setLevel('task', null);
    expect(auth.current).toBe('per_action');
  });

  it('does not approve pending confirmations when task level is rejected for a missing session', async () => {
    const shown: string[] = [];
    let cleared = 0;
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) shown.push(request.id); else cleared += 1; },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    expect(shown).toHaveLength(1);
    auth.setLevel('task', null);
    expect(auth.current).toBe('per_action');
    expect(cleared).toBe(0);
    expect(shown).toHaveLength(1);
    auth.revoke();
    await expect(promise).resolves.toBe(false);
  });

  it('carries full authorization chosen before identity is known', () => {
    let identity: string | null = null;
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => identity,
    });
    auth.setLevel('full');
    expect(auth.current).toBe('full');
    identity = 'u1';
    auth.syncIdentity();
    expect(auth.current).toBe('full');
    expect(makeAuth('u1').current).toBe('full');
  });

  it('downgrades host-provided full initial level and applies host task level per task', () => {
    const auth = makeAuth('u1');
    auth.setInitialLevel('full');
    expect(auth.current).toBe('per_action');
    expect(makeAuth('u1').current).toBe('per_action');

    const taskAuth = makeAuth('u2');
    taskAuth.setInitialLevel('task');
    expect(taskAuth.current).toBe('per_action');
    taskAuth.beginTask(9);
    expect(taskAuth.current).toBe('task');
    expect(taskAuth.decide('page_click', 9, { type: 'click', elementId: 'e1' }).allowed).toBe(true);
  });

  it('recomputes identity and drops grants when identity changes', () => {
    let identity = 'u1';
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => identity,
    });
    auth.setLevel('full');
    identity = 'u2';
    auth.syncIdentity();
    expect(auth.current).toBe('per_action');
  });

  it('redacts sensitive values except in the authorized scope', () => {
    const auth = makeAuth('u1');
    expect(auth.shouldRedactSensitive(1)).toBe(true);
    auth.setLevel('task', 1);
    expect(auth.shouldRedactSensitive(1)).toBe(false);
    expect(auth.shouldRedactSensitive(2)).toBe(true);
    auth.setLevel('full');
    expect(auth.shouldRedactSensitive(2)).toBe(false);
  });

  it('resolves confirmation requests from the UI', async () => {
    const requests: Array<{ id: string }> = [];
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) requests.push(request); },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    expect(requests).toHaveLength(1);
    auth.resolveConfirmation(requests[0]!.id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('cancels pending confirmations when the grant is revoked', async () => {
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: () => { /* UI 展示 */ },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    auth.revoke();
    await expect(promise).resolves.toBe(false);
  });

  it('rejects waiting and queued confirmations when the connection drops', async () => {
    const shown: string[] = [];
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) shown.push(request.id); },
    });
    const first = auth.requestConfirmation({ tool: 'page_fill', summary: '填写 A', risk: 'normal', sessionId: 1 });
    const second = auth.requestConfirmation({ tool: 'page_fill', summary: '填写 B', risk: 'normal', sessionId: 1 });
    expect(shown).toHaveLength(1);
    auth.rejectPendingConfirmations();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    // 断线后晚到的批准不应再放行已拒绝的确认
    auth.resolveConfirmation(shown[0]!, true);
    expect(shown).toHaveLength(1);
  });

  it('approves pending confirmations when the user upgrades the level', async () => {
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: () => { /* UI 展示 */ },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    auth.setLevel('full');
    await expect(promise).resolves.toBe(true);
  });

  it('shows one confirmation at a time and queues the rest', async () => {
    const shown: string[] = [];
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) shown.push(request.id); },
    });
    const first = auth.requestConfirmation({ tool: 'page_fill', summary: '填写 A', risk: 'normal', sessionId: 1 });
    const second = auth.requestConfirmation({ tool: 'page_fill', summary: '填写 B', risk: 'normal', sessionId: 1 });
    expect(shown).toHaveLength(1);
    auth.resolveConfirmation(shown[0]!, true);
    await expect(first).resolves.toBe(true);
    expect(shown).toHaveLength(2);
    auth.resolveConfirmation(shown[1]!, false);
    await expect(second).resolves.toBe(false);
  });

  it('keeps pending confirmations visible when downgrading to per_action', async () => {
    const shown: string[] = [];
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) shown.push(request.id); },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    auth.setLevel('per_action');
    expect(shown).toHaveLength(1);
    auth.resolveConfirmation(shown[0]!, true);
    await expect(promise).resolves.toBe(true);
  });

  it('does not approve a pending confirmation when the host sets task level', async () => {
    const shown: string[] = [];
    let cleared = 0;
    const auth = new PageAuthorization({
      serverUrl: 'https://mao.example.com', agentId: 7, scopeVersion: 'v1', identity: () => 'u1',
      onConfirmRequest: (request) => { if (request) shown.push(request.id); else cleared++; },
    });
    const promise = auth.requestConfirmation({ tool: 'page_click', summary: '点击保存', risk: 'normal', sessionId: 1 });
    auth.setLevel('task', 1, false);
    expect(cleared).toBe(0);
    auth.resolveConfirmation(shown[0]!, false);
    await expect(promise).resolves.toBe(false);
  });

  it('treats missing confirm UI as denied and classifies high risk clicks', async () => {
    const auth = makeAuth('u1');
    await expect(auth.requestConfirmation({ tool: 'page_click', summary: 'x', risk: 'normal', sessionId: 1 })).resolves.toBe(false);
    const risk = auth.riskOf({ type: 'click', elementId: 'e1' }, {
      elementId: 'e1', kind: 'button', role: 'button', type: 'submit', label: '提交订单', text: '提交订单',
      value: null, options: [], visible: true, inViewport: true, disabled: false, readonly: false,
      required: false, sensitive: false, inFrame: false, inShadowRoot: false, rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(risk).toBe('high');
  });

  it('emits state changes', () => {
    const onChange = vi.fn();
    const auth = makeAuth('u1', onChange);
    auth.setLevel('task', 5);
    expect(onChange).toHaveBeenCalledWith('task', 5);
  });
});
