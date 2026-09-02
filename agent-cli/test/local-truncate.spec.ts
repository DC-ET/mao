import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { persistToolResult } from '../src/local/truncate';
import { resolveRuntimeDir, resolveShellOutputDir } from '../src/local/paths';
import { WS_TRUNCATE_AT_BYTES } from '../src/ws/constants';

const SESSION_ID = 8080;

afterEach(() => {
  fs.rmSync(resolveRuntimeDir(SESSION_ID), { recursive: true, force: true });
});

function parse(result: unknown, requestId = 'req'): Record<string, unknown> {
  return JSON.parse(persistToolResult(SESSION_ID, requestId, result)) as Record<string, unknown>;
}

describe('persistToolResult', () => {
  it('returns the payload untouched and writes nothing when under the limit', () => {
    expect(parse({ output: 'ok', exit_code: 0 })).toEqual({ output: 'ok', exit_code: 0 });
    expect(fs.existsSync(resolveRuntimeDir(SESSION_ID))).toBe(false);
  });

  it('writes the full payload with 0600 only when truncation is needed', () => {
    const parsed = parse({ output: 'x'.repeat(WS_TRUNCATE_AT_BYTES + 10) }, 'big');
    expect(parsed.truncated).toBe(true);
    const file = path.join(resolveShellOutputDir(SESSION_ID), 'big.out');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(String(parsed.output_file)).toContain('big.out');
    expect(String(parsed.output)).toContain('truncated');
  });

  it('shrinks nested image data_uri instead of blowing the ws frame', () => {
    const parsed = parse({ media_type: 'image', mime: 'image/png', data_uri: `data:image/png;base64,${'A'.repeat(WS_TRUNCATE_AT_BYTES)}` }, 'img');
    expect(parsed.truncated).toBe(true);
    expect(parsed.mime).toBe('image/png');
    expect(String(parsed.data_uri).length).toBeLessThan(20000);
  });

  it('shrinks nested MCP results', () => {
    const parsed = parse({ result: { content: [{ type: 'text', text: 'y'.repeat(WS_TRUNCATE_AT_BYTES + 100) }] } }, 'mcp');
    expect(parsed.truncated).toBe(true);
    const nested = (parsed.result as { content: Array<{ text: string }> }).content[0].text;
    expect(nested.length).toBeLessThan(20000);
    expect(nested).toContain('truncated');
  });

  it('caps long match arrays and says how many were dropped', () => {
    const parsed = parse({
      matches: Array.from({ length: 5000 }, (_, i) => ({ file: `f${i}.ts`, line: i, content: 'z'.repeat(500) })),
    }, 'grep');
    expect(parsed.truncated).toBe(true);
    const matches = parsed.matches as unknown[];
    expect(matches.length).toBeLessThan(5000);
    expect(String(matches[matches.length - 1])).toMatch(/more items/);
  });

  it('keeps control fields the backend depends on even in the final fallback', () => {
    const parsed = parse({
      async: true,
      session_id: 'sh-1',
      exit_code: 0,
      completed: false,
      output_file: '~/.mao/agent-cli/runtime/1/shellOutput/sh-1.out',
      matches: Array.from({ length: 400 }, () => ({ content: 'q'.repeat(9000) })),
    }, 'ctl');
    expect(parsed.async).toBe(true);
    expect(parsed.session_id).toBe('sh-1');
    expect(parsed.exit_code).toBe(0);
    expect(parsed.completed).toBe(false);
    expect(parsed.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(WS_TRUNCATE_AT_BYTES);
  });

  it('previews non-object payloads that exceed the limit', () => {
    const parsed = parse('n'.repeat(WS_TRUNCATE_AT_BYTES + 50), 'raw');
    expect(parsed.truncated).toBe(true);
    expect(String(parsed.preview).length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(WS_TRUNCATE_AT_BYTES);
  });
});
