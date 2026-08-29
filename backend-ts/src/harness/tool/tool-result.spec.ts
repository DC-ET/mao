import { describe, expect, it } from 'vitest';
import { normalizeToolResult, toolResultMeta } from './tool-result.js';

describe('normalizeToolResult', () => {
  it('marks plain text as success', () => {
    const r = normalizeToolResult('c1', 'hello');
    expect(r.status).toBe('success');
    expect(r.content).toBe('hello');
    expect(r.errorMessage).toBeUndefined();
  });

  it('marks non-json text as success', () => {
    const r = normalizeToolResult('c2', 'not json at all');
    expect(r.status).toBe('success');
  });

  it('marks object containing error key as error with message', () => {
    const r = normalizeToolResult('c3', '{"error":"kaboom","exit_code":1}');
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBe('kaboom');
    expect(r.content).toBe('{"error":"kaboom","exit_code":1}');
  });

  it('marks object with non-string error value as error without message', () => {
    const r = normalizeToolResult('c4', '{"error":{}}');
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBeUndefined();
  });

  it('marks object with empty-string error value as error without message', () => {
    const r = normalizeToolResult('c5', '{"error":""}');
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBeUndefined();
  });

  it('marks success json without error key as success', () => {
    const r = normalizeToolResult('c6', '{"ok":true,"bytes":1}');
    expect(r.status).toBe('success');
  });

  it('marks array as success (object-like but not a plain object)', () => {
    const r = normalizeToolResult('c7', '["a"]');
    expect(r.status).toBe('success');
  });

  it('marks object with non-zero exit_code as error without message', () => {
    const r = normalizeToolResult('c11', '{"exit_code":1,"output":"boom"}');
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBeUndefined();
  });

  it('marks object with zero exit_code as success', () => {
    const r = normalizeToolResult('c12', '{"exit_code":0,"output":"ok"}');
    expect(r.status).toBe('success');
  });

  it('marks records durationMs', () => {
    const r = normalizeToolResult('c8', 'ok', 123);
    expect(r.durationMs).toBe(123);
  });
});

describe('toolResultMeta', () => {
  it('extracts meta subset from a result', () => {
    const r = normalizeToolResult('c9', '{"error":"x"}', 9);
    expect(toolResultMeta(r)).toEqual({ status: 'error', errorMessage: 'x', durationMs: 9 });
  });

  it('success meta omits errorMessage', () => {
    expect(toolResultMeta(normalizeToolResult('c10', 'ok'))).toEqual({
      status: 'success',
      errorMessage: undefined,
      durationMs: undefined,
    });
  });
});
