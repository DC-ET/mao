import { describe, expect, it } from 'vitest';
import { acceptEvent, isTerminalStatus } from '../src/ws/event-filter';
import type { WsEvent } from '../src/ws/event-types';

function evt(type: string, sessionId: number | null, data: Record<string, unknown> | null = {}): WsEvent {
  return { type, sessionId, data };
}

describe('acceptEvent', () => {
  it('drops events from other sessions', () => {
    expect(acceptEvent(evt('session_status', 99, { phase: 'COMPLETED', executionId: 'a' }), 1, 'a')).toBe(false);
  });

  it('keeps connection-level events with null sessionId', () => {
    expect(acceptEvent(evt('connected', null, { userId: 1 }), 1, 'a')).toBe(true);
    expect(acceptEvent(evt('pong', null, {}), 1, 'a')).toBe(true);
  });

  it('drops stale executionId', () => {
    expect(acceptEvent(evt('content_delta', 1, { executionId: 'old', delta: 'x' }), 1, 'new')).toBe(false);
  });

  it('keeps matching session + execution', () => {
    expect(acceptEvent(evt('content_delta', 1, { executionId: 'new', delta: 'x' }), 1, 'new')).toBe(true);
  });

  it('keeps events without executionId when we have one', () => {
    expect(acceptEvent(evt('todo_updated', 1, { todos: [] }), 1, 'new')).toBe(true);
  });
});

describe('isTerminalStatus', () => {
  it('matches COMPLETED with same executionId', () => {
    expect(isTerminalStatus(evt('session_status', 1, { phase: 'COMPLETED', executionId: 'e1' }), 'e1', true)).toBe(true);
  });

  it('rejects COMPLETED of another execution', () => {
    expect(isTerminalStatus(evt('session_status', 1, { phase: 'COMPLETED', executionId: 'other' }), 'e1', true)).toBe(false);
  });

  it('falls back when executionId is missing and this round has seen RUNNING', () => {
    expect(isTerminalStatus(evt('session_status', 1, { phase: 'FAILED' }), 'e1', true)).toBe(true);
  });

  it('does not treat missing executionId as terminal before RUNNING', () => {
    expect(isTerminalStatus(evt('session_status', 1, { phase: 'COMPLETED' }), 'e1', false)).toBe(false);
  });

  it('ignores non-status events', () => {
    expect(isTerminalStatus(evt('error', 1, { phase: 'FAILED' }), 'e1', true)).toBe(false);
  });
});
