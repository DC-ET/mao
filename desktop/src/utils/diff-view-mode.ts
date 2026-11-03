/**
 * Diff 查看器的视图模式工具（纯函数，供 FileDiffViewer 与单测共用，
 * jsdom 单测不加载 Monaco）。
 */

/** Diff 行内模式初始值：有过切换以 localStorage 为准（'1'=行内），否则按视口宽窄兜底（<640px 行内）。 */
export function resolveInitialDiffInlineMode(stored: string | null, viewportWidth: number): boolean {
  return stored != null ? stored === '1' : viewportWidth < 640
}

/**
 * 传给 Monaco DiffEditor 的布局选项。
 * 默认 `useInlineViewWhenSpaceIsLimited` 会在编辑器宽度 ≤900px 时忽略
 * `renderSideBySide`，三栏中间区常低于此值，胶囊上的「并排」看起来没有变化。
 * 显式关掉，让并排 / 行内始终按用户选择渲染。
 */
export function diffEditorLayoutOptions(inline: boolean): {
  renderSideBySide: boolean
  useInlineViewWhenSpaceIsLimited: false
} {
  return {
    renderSideBySide: !inline,
    useInlineViewWhenSpaceIsLimited: false,
  }
}

/** 变更跳转游标：循环步进（Δ=±1），总数为 0 时原样返回 -1。 */
export function nextHunkIndex(current: number, total: number, delta: 1 | -1): number {
  if (total <= 0) return -1
  return (current + delta + total) % total
}
