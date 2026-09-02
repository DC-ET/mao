import fs from 'node:fs';
import path from 'node:path';
import { WS_TRUNCATE_AT_BYTES } from '../ws/constants';
import { ensureDir, formatRuntimeDisplay, resolveShellOutputDir } from './paths';

const MARK = '…[truncated: full output written to disk]';
const FIELD_LIMIT_BYTES = 8000;
/** 后端 tool-dispatcher.dispatchLocalShellAsync 依赖这些字段，任何裁剪都必须保留。 */
const CONTROL_KEYS = ['exit_code', 'session_id', 'async', 'completed', 'success', 'task_id'];

interface Budget {
  remaining: number;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value);
}

/** 序列化后的字节数（含引号与转义），预算一律以此为单位。 */
function jsonSize(value: unknown): number {
  const json = JSON.stringify(value);
  return json == null ? 0 : byteLength(json);
}

/** 字符串序列化后去掉两侧引号的字节数。 */
function escapedSize(value: string): number {
  return jsonSize(value) - 2;
}

/** 按字节截断，丢掉末尾被切断的多字节字符。 */
function sliceBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(value) <= maxBytes) return value;
  return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '');
}

/** 截断到「序列化后不超过 maxBytes」：JSON 转义（引号、控制字符）会放大体积，按原始字节切不够。 */
function sliceEscaped(value: string, maxBytes: number): string {
  let cut = sliceBytes(value, maxBytes);
  while (cut !== '' && escapedSize(cut) > maxBytes) {
    cut = sliceBytes(cut, Math.floor(byteLength(cut) / 2));
  }
  return cut;
}

function shrinkString(value: string, budget: Budget): string {
  const size = jsonSize(value);
  if (size <= FIELD_LIMIT_BYTES && size <= budget.remaining) {
    budget.remaining -= size;
    return value;
  }
  const target = Math.min(FIELD_LIMIT_BYTES, budget.remaining);
  const cut = sliceEscaped(value, target - escapedSize(MARK) - 2) + MARK;
  budget.remaining -= jsonSize(cut);
  return cut;
}

/**
 * 自顶向下按剩余预算裁剪：字符串超限即截断，数组保留能装下的前若干项，对象递归。
 * 预算在整棵树上共享，因此结果大小有上界 —— 单个超大数组不会把整个结果挤成一句 preview。
 */
function shrink(node: unknown, budget: Budget): unknown {
  if (typeof node === 'string') return shrinkString(node, budget);
  if (Array.isArray(node)) {
    budget.remaining -= 2;
    const kept: unknown[] = [];
    for (const item of node) {
      const marker = `${MARK} (${node.length - kept.length} more items)`;
      if (budget.remaining <= jsonSize(marker) + 1) {
        kept.push(marker);
        break;
      }
      budget.remaining -= 1;
      kept.push(shrink(item, budget));
    }
    return kept;
  }
  if (node && typeof node === 'object') {
    budget.remaining -= 2;
    const entries = Object.entries(node as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    // 控制字段先占预算，保证它们不会被前面的大字段挤掉。
    for (const [key, value] of entries) {
      if (!CONTROL_KEYS.includes(key)) continue;
      budget.remaining -= jsonSize(key) + 2 + jsonSize(value);
      out[key] = value;
    }
    for (const [key, value] of entries) {
      if (CONTROL_KEYS.includes(key)) continue;
      budget.remaining -= jsonSize(key) + 2;
      out[key] = shrink(value, budget);
    }
    return out;
  }
  budget.remaining -= jsonSize(node);
  return node;
}

function keepControlFields(parsed: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTROL_KEYS) {
    if (key in parsed) out[key] = parsed[key];
  }
  return out;
}

/**
 * 只在需要截断时把完整结果落盘（明文），避免每个工具结果（含 .env、私钥内容）长期留在
 * ~/.mao/agent-cli/runtime 下。返回值即回给后端的 result 字符串。
 */
export function persistToolResult(sessionId: number, requestId: string, result: unknown): string {
  const json = typeof result === 'string' ? result : JSON.stringify(result);
  if (byteLength(json) <= WS_TRUNCATE_AT_BYTES) return json;

  const dir = resolveShellOutputDir(sessionId);
  ensureDir(dir);
  const fileName = `${requestId}.out`;
  fs.writeFileSync(path.join(dir, fileName), json, { encoding: 'utf8', mode: 0o600 });
  const display = formatRuntimeDisplay(sessionId, 'shellOutput', fileName);

  let parsed: Record<string, unknown>;
  try {
    const node = JSON.parse(json) as unknown;
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('not an object');
    parsed = node as Record<string, unknown>;
  } catch {
    const overhead = jsonSize({ truncated: true, output_file: display, preview: '' });
    const preview = sliceEscaped(json, WS_TRUNCATE_AT_BYTES - overhead - escapedSize(MARK)) + MARK;
    return JSON.stringify({ truncated: true, output_file: display, preview });
  }

  const budget: Budget = { remaining: WS_TRUNCATE_AT_BYTES - jsonSize({ truncated: true, output_file: display }) };
  const shrunk = shrink(parsed, budget) as Record<string, unknown>;
  shrunk.truncated = true;
  shrunk.output_file = display;
  const out = JSON.stringify(shrunk);
  if (byteLength(out) <= WS_TRUNCATE_AT_BYTES) return out;

  return JSON.stringify({
    ...keepControlFields(parsed),
    truncated: true,
    output_file: display,
    preview: MARK,
  });
}
