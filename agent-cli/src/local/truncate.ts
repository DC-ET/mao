import fs from 'node:fs';
import path from 'node:path';
import { WS_TRUNCATE_AT_BYTES } from '../ws/constants';
import { ensureDir, formatRuntimeDisplay, resolveShellOutputDir } from './paths';

const MARK = '…[truncated: full output written to disk]';

export function persistToolResult(sessionId: number, requestId: string, result: unknown): string {
  const json = typeof result === 'string' ? result : JSON.stringify(result);
  const dir = resolveShellOutputDir(sessionId);
  ensureDir(dir);
  const fileName = `${requestId}.out`;
  const absPath = path.join(dir, fileName);
  fs.writeFileSync(absPath, json, { encoding: 'utf8', mode: 0o600 });
  const bytes = Buffer.byteLength(json);
  if (bytes <= WS_TRUNCATE_AT_BYTES) return json;

  const display = formatRuntimeDisplay(sessionId, 'shellOutput', fileName);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    const keep = Math.max(0, WS_TRUNCATE_AT_BYTES - 200);
    return JSON.stringify({
      truncated: true,
      output_file: display,
      preview: json.slice(0, keep) + MARK,
    });
  }
  parsed.truncated = true;
  parsed.output_file = display;
  for (const key of ['output', 'content', 'result', 'error']) {
    if (typeof parsed[key] === 'string' && Buffer.byteLength(String(parsed[key])) > 8000) {
      parsed[key] = String(parsed[key]).slice(0, 8000) + MARK;
    }
  }
  let out = JSON.stringify(parsed);
  if (Buffer.byteLength(out) > WS_TRUNCATE_AT_BYTES) {
    out = JSON.stringify({ truncated: true, output_file: display, preview: MARK });
  }
  return out;
}
