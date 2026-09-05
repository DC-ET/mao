/**
 * 主色派生：宿主可以传任意 theme.primary，包括白色、浅黄这类高亮度色。
 * 固定压白字会让用户气泡/按钮文字完全看不见，故按 WCAG 相对亮度算出：
 * - onPrimary：压在主色底上的文字色
 * - primaryInk：主色当文字/描边用时的可读版本（过浅则压暗）
 * - primaryEdge：主色过浅时补的一圈描边，避免白气泡在白面板上没有边界
 */

type Rgb = [number, number, number];

const DARK_INK = '#1d1d1f';
const WHITE_LUM = 1;
/** 文字对白底的目标对比度（WCAG AA 正文） */
const TEXT_CONTRAST_TARGET = 4.5;
/** 超过此亮度视为"接近白"，需要补描边 */
const EDGE_LUM_THRESHOLD = 0.75;

export interface DerivedTheme {
  onPrimary: string;
  primaryInk: string;
  primaryEdge: string | null;
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function parseHex(hex: string): Rgb | null {
  const h = hex.slice(1);
  // #rgb / #rgba
  if (h.length === 3 || h.length === 4) {
    const [r, g, b] = [...h.slice(0, 3)].map((c) => parseInt(c + c, 16));
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  // #rrggbb / #rrggbbaa
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : [r, g, b];
  }
  return null;
}

function parseRgbFunc(input: string): Rgb | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3);
  if (parts.length < 3) return null;
  const nums = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)));
  return nums.some((n) => Number.isNaN(n)) ? null : [clamp255(nums[0]), clamp255(nums[1]), clamp255(nums[2])];
}

/** 颜色关键字（white/tomato…）交给浏览器 CSSOM 归一化为 rgb() */
function normalizeViaCssom(input: string): string | null {
  if (typeof document === 'undefined') return null;
  const probe = document.createElement('span');
  probe.style.color = input;
  const v = probe.style.color;
  return v && v.toLowerCase() !== input.toLowerCase() ? v : null;
}

export function parseColor(input: string): Rgb | null {
  const s = input.trim();
  if (!s) return null;
  if (s.startsWith('#')) return parseHex(s);
  const fromFunc = parseRgbFunc(s);
  if (fromFunc) return fromFunc;
  const normalized = normalizeViaCssom(s);
  return normalized ? parseRgbFunc(normalized) : null;
}

/** WCAG 相对亮度 */
export function luminance([r, g, b]: Rgb): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** 逐步压暗直到对白底达到目标对比度（迭代上限兜底纯白等极端值） */
function darkenForText(rgb: Rgb): Rgb {
  let cur = rgb;
  for (let i = 0; i < 24 && contrast(luminance(cur), WHITE_LUM) < TEXT_CONTRAST_TARGET; i++) {
    cur = [clamp255(cur[0] * 0.85), clamp255(cur[1] * 0.85), clamp255(cur[2] * 0.85)];
    // 纯白/近白按比例缩放收敛慢，直接线性下拉
    if (cur[0] === rgb[0] && cur[1] === rgb[1] && cur[2] === rgb[2]) {
      cur = [clamp255(cur[0] - 32), clamp255(cur[1] - 32), clamp255(cur[2] - 32)];
    }
    rgb = cur;
  }
  return cur;
}

function toCss([r, g, b]: Rgb): string {
  return `rgb(${r}, ${g}, ${b})`;
}

export function deriveTheme(primary: string): DerivedTheme | null {
  const rgb = parseColor(primary);
  if (!rgb) return null;
  const lum = luminance(rgb);
  const onPrimary = contrast(lum, WHITE_LUM) >= contrast(lum, luminance([29, 29, 31])) ? '#fff' : DARK_INK;
  const ink =
    contrast(lum, WHITE_LUM) >= TEXT_CONTRAST_TARGET ? toCss(rgb) : toCss(darkenForText(rgb));
  return {
    onPrimary,
    primaryInk: ink,
    primaryEdge: lum > EDGE_LUM_THRESHOLD ? 'rgba(0, 0, 0, 0.14)' : null,
  };
}

/** 写入 Shadow DOM 根节点的内联自定义属性（优先级高于 style.css 里的默认值） */
export function applyTheme(root: HTMLElement, primary: string): void {
  root.style.setProperty('--mao-primary', primary);
  const derived = deriveTheme(primary);
  if (!derived) return;
  root.style.setProperty('--mao-on-primary', derived.onPrimary);
  root.style.setProperty('--mao-primary-ink', derived.primaryInk);
  if (derived.primaryEdge) root.style.setProperty('--mao-primary-edge', derived.primaryEdge);
}
