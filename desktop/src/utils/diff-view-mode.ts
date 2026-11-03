/**
 * Diff 查看器的视图模式工具（纯函数，供 FileDiffViewer 与单测共用，
 * jsdom 单测不加载 Monaco）。
 */

/** Diff 行内模式初始值：有过切换以 localStorage 为准（'1'=行内），否则按视口宽窄兜底（<640px 行内）。 */
export function resolveInitialDiffInlineMode(stored: string | null, viewportWidth: number): boolean {
  return stored != null ? stored === '1' : viewportWidth < 640
}

/** 变更跳转游标：循环步进（Δ=±1），总数为 0 时原样返回 -1。 */
export function nextHunkIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}
