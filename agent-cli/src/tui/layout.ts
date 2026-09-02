import type { LayoutBudget } from './types';
import { displayWidth } from '../ui/width';

/**
 * 布局预算：live（非 Static）区域的总高度必须始终小于终端行数。
 *
 * Ink3 在 `outputHeight >= stdout.rows` 时会走 `clearTerminal + fullStaticOutput + output`
 * 分支（ink/build/ink.js），即每帧整屏重绘并用 `\x1b[3J` 清掉 scrollback。
 * 流式输出下这意味着每个 delta 都重刷全屏、历史滚不回去。
 * 唯一可靠的规避方式是让 live 树永远矮于终端，把定稿内容交给 <Static>。
 */

const MIN_ROWS = 8;
const MIN_COLUMNS = 20;

export function computeBudget(rows?: number, columns?: number): LayoutBudget {
  const r = Math.max(MIN_ROWS, rows && rows > 0 ? rows : 24);
  const c = Math.max(MIN_COLUMNS, columns && columns > 0 ? columns : 80);
  // 扣掉 footer(1) + 输入框边框(2) + 2 行安全余量后可供分配的高度
  const avail = Math.max(3, r - 5);
  const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    rows: r,
    columns: c,
    draftRows: clamp(1, Math.floor(avail * 0.4), 10),
    announceRows: clamp(1, Math.floor(avail * 0.25), 6),
    toolRows: clamp(1, Math.floor(avail * 0.25), 6),
    tailRows: clamp(1, Math.floor(avail * 0.4), 12),
    thinkingRows: clamp(1, Math.floor(avail * 0.2), 4),
    paletteRows: clamp(2, Math.floor(avail * 0.4), 8),
  };
}

export interface LiveWant {
  status: boolean;
  announce: number;
  tools: number;
  tail: number;
  thinking: number;
}

export interface LiveSizes {
  status: number;
  announce: number;
  tools: number;
  tail: number;
  thinking: number;
  total: number;
}

/**
 * 把 live 可用行数按优先级分给各区块：状态 > 提示 > 运行中工具 > 正文尾行 > 思考。
 * `reserved` 是输入框（或弹窗）+ footer 已确定占用的行数。
 */
export function allocateLive(args: {
  budget: LayoutBudget;
  reserved: number;
  want: LiveWant;
}): LiveSizes {
  const { budget, reserved, want } = args;
  // 留 2 行余量：footer 结尾换行 + 终端最后一行光标
  let remain = Math.max(0, budget.rows - 2 - reserved);
  const take = (wanted: number, cap: number): number => {
    const n = Math.max(0, Math.min(wanted, cap, remain));
    remain -= n;
    return n;
  };

  const status = take(want.status ? 1 : 0, 1);
  const announce = take(want.announce, budget.announceRows);
  const tools = take(want.tools, budget.toolRows);
  const tail = take(want.tail, budget.tailRows);
  const thinking = take(want.thinking, budget.thinkingRows);

  return {
    status,
    announce,
    tools,
    tail,
    thinking,
    total: status + announce + tools + tail + thinking,
  };
}

/** 按终端列宽折行（CJK 计 2 列），返回每行不超过 columns 的片段。 */
export function wrapByWidth(text: string, columns: number): string[] {
  const cols = Math.max(4, columns);
  if (!text) return [];
  const out: string[] = [];
  let cur = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > cols) {
      out.push(cur);
      cur = ch;
      width = w;
      continue;
    }
    cur += ch;
    width += w;
  }
  out.push(cur);
  return out;
}

/** 取文本末尾最多 rows 个可视行（流式尾巴只需要看最新的部分）。 */
export function tailRows(text: string, columns: number, rows: number): string[] {
  if (rows <= 0 || !text) return [];
  const wrapped = wrapByWidth(text, columns);
  return wrapped.slice(Math.max(0, wrapped.length - rows));
}
