/**
 * 回放缓冲的「应答诱饵」过滤。
 *
 * 环形缓冲存的是 PTY 的全部历史输出，其中除可见内容外还有两类不可见序列：
 *   1. 程序当年发出的终端查询——OSC 10/11/12/4 颜色查询（vim 探测主题色）、
 *      CSI c / CSI n 的 DA/DSR、DECRQM（CSI ? Pm $ p）、DECRQSS（DCS $ q）、
 *      XTGETTCAP（DCS + q）、XTWINOPS 尺寸查询（CSI 14/16/18 t）；
 *   2. 开启后持续向 PTY 发字节的上报模式——焦点上报 CSI ? 1004 h、鼠标上报
 *      CSI ? 9/1000/1002/1003 h。
 *
 * 重新 attach 时整段缓冲原样回放给 xterm.js，xterm 把这些旧查询当成新查询自动
 * 生成应答；应答与键盘输入共用 onData（CoreTerminal 把 triggerDataEvent 转发到
 * onData），于是经 input 帧回到 PTY 输入，bash 行规程回显并执行——每次重开终端
 * 面板都刷一屏 `276: command not found` / `bash: rgb:…: No such file or directory`，
 * 且新垃圾又写回缓冲、下次回放再触发，越攒越多。
 *
 * 因此回放前必须剔除会引发应答的序列。实时流不能过滤：活着的程序（如正在运行的
 * vim）确实在等应答。代价是回放不再恢复上报类模式，活着的程序下次重绘会自行重发。
 */

const ESC = '\u001b';
const BEL = '\u0007';

/** OSC 颜色查询号：负载里出现 `?` 字段时 xterm.js 回颜色报告。 */
const OSC_COLOR_QUERY_IDS: ReadonlySet<number> = new Set([4, 10, 11, 12]);

/** DEC 私有模式中「开启后持续向 PTY 发字节」的上报类模式（1006 只是 SGR 编码，单独开启不产生上报）。 */
const REPORTING_MODES: ReadonlySet<number> = new Set([9, 1000, 1002, 1003, 1004]);

/** XTWINOPS 中带查询语义（xterm.js 回尺寸报告）的操作。 */
const XTWINOPS_QUERY_OPS: ReadonlySet<number> = new Set([14, 16, 18]);

type Decision =
  /** 原样保留，跳过整条序列。 */
  | { action: 'keep'; end: number }
  /** 整条剔除。 */
  | { action: 'drop'; end: number }
  /** 剔除部分参数后按 text 重写（如 CSI ? 1004;1049 h → CSI ? 1049 h）。 */
  | { action: 'rewrite'; end: number; text: string };

/** 字符串型序列（OSC/DCS/SOS/PM/APC）的终止符：BEL 或 ST（ESC \）。 */
interface StringSpan {
  /** 内容结束位置（不含终止符）。 */
  contentEnd: number;
  /** 下一条序列的起始扫描位置。 */
  end: number;
  /** 未正常闭合：跑到缓冲区末尾，或遇到非 ST 的 ESC（xterm 解析器同样就地结束字符串态）。 */
  unterminated: boolean;
}

/**
 * 剔除回放数据里会引发终端自动应答的序列。
 * 纯文本、SGR、光标移动、OSC 8 超链接、标题等可见或无害序列原样保留。
 */
export function sanitizeReplayData(data: string): string {
  if (data === '') return '';
  const parts: string[] = [];
  const n = data.length;
  let copied = 0;
  let i = 0;
  while (i < n) {
    if (data[i] !== ESC) {
      i += 1;
      continue;
    }
    const decision = classifyEscape(data, i);
    if (decision.action !== 'keep') {
      if (copied < i) parts.push(data.slice(copied, i));
      if (decision.action === 'rewrite') parts.push(decision.text);
      copied = decision.end;
    }
    i = decision.end;
  }
  if (copied < n) parts.push(data.slice(copied));
  return parts.join('');
}

/** 解析 data[i]（必为 ESC）起始的转义序列，决定回放时如何处理。 */
function classifyEscape(data: string, i: number): Decision {
  const next = data[i + 1];
  // 末尾裸 ESC：半条序列，丢弃（否则回放后解析器停在转义态，实时流的后续字节会被吞或补全成查询）
  if (next === undefined) return { action: 'drop', end: data.length };
  switch (next) {
    case '[':
      return classifyCsi(data, i);
    case ']':
      return classifyOsc(data, i);
    case 'P':
      return classifyDcs(data, i);
    // SOS / PM / APC：无应答语义，但同样是字符串型序列，要整体跳过避免内容干扰扫描
    case 'X':
    case '^':
    case '_': {
      const span = scanStringSpan(data, i + 2);
      // 跑到缓冲区末尾的保留；被非 ST 的 ESC 截断的整条剔除（否则回放留下悬空字符串态）
      if (!span) return { action: 'keep', end: data.length };
      return { action: span.unterminated ? 'drop' : 'keep', end: span.end };
    }
    default: {
      const span = scanPlainEscape(data, i);
      return { action: span.aborted ? 'drop' : 'keep', end: span.end };
    }
  }
}

/** CSI（ESC [ ... 终字节）：DA / DSR / DECRQM / XTWINOPS 查询与上报类模式设置。 */
function classifyCsi(data: string, i: number): Decision {
  const n = data.length;
  let p = i + 2;
  const paramStart = p;
  while (p < n) {
    const code = data.charCodeAt(p);
    // 参数字节 0x30–0x3f：0-9 : ; < = > ?
    if (code >= 0x30 && code <= 0x3f) p += 1;
    else break;
  }
  const params = data.slice(paramStart, p);
  const intermediateStart = p;
  while (p < n) {
    const code = data.charCodeAt(p);
    // 中间字节 0x20–0x2f：空格 ! " # $ % & ' ( ) * + , - . /
    if (code >= 0x20 && code <= 0x2f) p += 1;
    else break;
  }
  const intermediates = data.slice(intermediateStart, p);
  // 半条 CSI 被 chunk 边界切断：丢弃尾部，避免实时流的后续字节把它补全成查询
  if (p >= n) return { action: 'drop', end: n };
  const finalCode = data.charCodeAt(p);
  // C0 控制或非 ASCII 字节落在终字节位（畸形序列）：整条剔除。既避免回放留下悬空的
  // ESC [ 吞掉实时流字节，也避免剩下的 "6n" 之类被实时流补全成 DSR 查询
  if (finalCode < 0x20 || finalCode > 0x7e) return { action: 'drop', end: p };
  const final = data[p];
  const end = p + 1;

  // DECRQM：CSI ? Pm $ p / CSI Pm $ p → CSI ? Pm;Ps $ y
  if (intermediates === '$' && final === 'p') return { action: 'drop', end };
  // DA：CSI c（一级）/ CSI > c（二级）/ CSI = c（三级），全部以 c 结尾
  if (final === 'c') return { action: 'drop', end };
  // DSR/CPR：CSI 5 n / CSI 6 n / CSI ? 6 n / CSI ? 15 n …
  if (final === 'n') return { action: 'drop', end };
  // XTWINOPS 尺寸查询：CSI 14/16/18 t
  if (final === 't') {
    const op = firstNumericParam(params);
    if (op !== null && XTWINOPS_QUERY_OPS.has(op)) return { action: 'drop', end };
    return { action: 'keep', end };
  }
  // 上报类 DEC 私有模式设置：只剔这些参数，同序列里的其它模式（如 1049 备用屏）保留
  if (final === 'h' && params.startsWith('?')) {
    const modes = numericParams(params.slice(1));
    const kept = modes.filter((mode) => !REPORTING_MODES.has(mode));
    if (kept.length === 0) return { action: 'drop', end };
    if (kept.length !== modes.length) return { action: 'rewrite', end, text: `${ESC}[?${kept.join(';')}h` };
    return { action: 'keep', end };
  }
  return { action: 'keep', end };
}

/** OSC（ESC ] ... ST|BEL）：颜色查询。 */
function classifyOsc(data: string, i: number): Decision {
  const span = scanStringSpan(data, i + 2);
  // 未闭合：整条剔除，避免回放后解析器停在 OSC 字符串态吞掉实时流的后续字节
  if (!span) return { action: 'drop', end: data.length };
  if (span.unterminated) return { action: 'drop', end: span.end };
  const payload = data.slice(i + 2, span.contentEnd);
  const separator = payload.indexOf(';');
  if (separator > 0) {
    const ident = Number(payload.slice(0, separator));
    if (OSC_COLOR_QUERY_IDS.has(ident)) {
      // 查询形态：OSC 10;? / OSC 4;0;? / OSC 4;?;? —— 任一字段为 ?
      if (payload.slice(separator + 1).split(';').includes('?')) {
        return { action: 'drop', end: span.end };
      }
    }
  }
  return { action: 'keep', end: span.end };
}

/** DCS（ESC P ... ST|BEL）：DECRQSS（$ q）与 XTGETTCAP（+ q）查询。 */
function classifyDcs(data: string, i: number): Decision {
  const span = scanStringSpan(data, i + 2);
  if (!span) return { action: 'drop', end: data.length };
  if (span.unterminated) return { action: 'drop', end: span.end };
  const payload = data.slice(i + 2, span.contentEnd);
  // xterm.js 6.0.0 只实现了 DECRQSS，XTGETTCAP 暂不应答；两者都按查询剔除，防止升级后复活
  if (payload.startsWith('$q') || payload.startsWith('+q')) {
    return { action: 'drop', end: span.end };
  }
  return { action: 'keep', end: span.end };
}

/** 扫描 OSC/DCS 等字符串型序列的终止符。 */
function scanStringSpan(data: string, from: number): StringSpan | null {
  for (let p = from; p < data.length; p += 1) {
    const ch = data[p];
    if (ch === BEL) return { contentEnd: p, end: p + 1, unterminated: false };
    if (ch === ESC) {
      // ST（ESC \）才是正常终止；字符串区内出现其它 ESC 时按 xterm 解析器行为就地结束，
      // 但整条序列视为未闭合（调用方剔除），避免回放后解析器停在字符串态吞掉实时流
      if (data[p + 1] === '\\') return { contentEnd: p, end: p + 2, unterminated: false };
      return { contentEnd: p, end: p, unterminated: true };
    }
  }
  return null;
}

/** 普通 ESC 序列的扫描结果：结束位置，以及是否被 C0/ESC 就地中止（畸形）。 */
interface PlainEscapeSpan {
  end: number;
  aborted: boolean;
}

/** 普通 ESC 序列：ESC + 若干中间字节（0x20–0x2f）+ 终字节（0x30–0x7e）。 */
function scanPlainEscape(data: string, i: number): PlainEscapeSpan {
  let p = i + 1;
  while (p < data.length) {
    const code = data.charCodeAt(p);
    // 中间字节（如 ESC ( B、ESC # 8、ESC % G 的 ( # %）：继续收集
    if (code >= 0x20 && code <= 0x2f) {
      p += 1;
      continue;
    }
    // 终字节：序列到此结束
    if (code >= 0x30 && code <= 0x7e) return { end: p + 1, aborted: false };
    // C0 控制或 ESC：xterm 就地中止当前序列并以该字节重新解析（ESC ( ESC P 不是三字节序列），
    // 这里同样交还给外层，否则会漏掉中止处后面的查询序列；半条前缀按畸形剔除，避免留下裸 ESC
    return { end: p, aborted: true };
  }
  // 跑到缓冲区末尾的半条序列（如 ESC (）：保留，xterm 会用实时流的下一个字节补全，无应答语义
  return { end: data.length, aborted: false };
}

/** 取 CSI 参数串的第一个数值参数（跳过 < = > ? 私有前缀），非数字返回 null。 */
function firstNumericParam(params: string): number | null {
  const first = numericParams(params)[0];
  return first === undefined ? null : first;
}

/** 解析 CSI 参数串里的数值参数（跳过私有前缀，忽略空参数）。 */
function numericParams(params: string): number[] {
  const result: number[] = [];
  for (const raw of params.replace(/^[<=>?]/, '').split(';')) {
    if (raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) result.push(value);
  }
  return result;
}
