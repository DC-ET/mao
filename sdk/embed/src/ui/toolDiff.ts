/**
 * 工具调用 diff 展示（edit_file 富视图）：把 old_string → new_string 渲染成行级 diff。
 * 与 desktop/src/utils/toolDiff.ts 同一份实现（口径与后端 FileChangeDiffUtil 对齐：
 * LCS、3 行上下文折叠、末尾换行不产生空行），只处理「替换片段」而非整文件——
 * old/new 本身就是 hunk，不需要行号；上下文行只为肉眼定位。
 */

/** 与后端 file-change-diff-util.ts 的 LCS_CELL_LIMIT 同口径：超出后退化为整段替换，避免大文件 O(n*m) 爆炸。 */
const LCS_CELL_LIMIT = 2_000_000;
const CONTEXT_LINES = 3;

export type DiffLineType = 'context' | 'del' | 'add'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/** hunk = 一段要展示的行；gap = 两段 hunk 之间被折叠掉的未变化行数。 */
export type DiffBlock =
  | { kind: 'hunk'; lines: DiffLine[] }
  | { kind: 'gap'; count: number }

export interface EditDiff {
  blocks: DiffBlock[]
  added: number
  deleted: number
}

/** 与后端 splitLines 同口径：末尾换行不产生空行，兼容 CRLF/CR。 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

type DiffOp = 'equal' | 'del' | 'add'

/**
 * LCS 回溯产出 op 序列。超 cell 上限（超大片段）时退化为「全删 + 全增」，
 * 与后端 computeLineDelta 的降级思路一致：宁可显示整段替换，不可卡死渲染。
 */
function diffOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  if (n === 0) return new Array<DiffOp>(m).fill('add')
  if (m === 0) return new Array<DiffOp>(n).fill('del')
  if (n * m > LCS_CELL_LIMIT) {
    return [...new Array<DiffOp>(n).fill('del'), ...new Array<DiffOp>(m).fill('add')]
  }

  const width = m + 1
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度，倒填表后从 (0,0) 正向回溯
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] = a[i] === b[j]
        ? dp[(i + 1) * width + (j + 1)] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('equal')
      i++
      j++
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      ops.push('del')
      i++
    } else {
      ops.push('add')
      j++
    }
  }
  while (i < n) { ops.push('del'); i++ }
  while (j < m) { ops.push('add'); j++ }
  return ops
}

/**
 * 把 op 序列折叠成 hunk 块：每个变化行前后各保留 CONTEXT_LINES 行上下文，
 * 其余未变化行合并为 gap。无变化时返回空 blocks（调用方回退原始 JSON 展示）。
 */
export function buildEditDiff(oldText: string, newText: string): EditDiff {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = diffOps(a, b)

  const entries: DiffLine[] = []
  let ai = 0
  let bi = 0
  for (const op of ops) {
    if (op === 'equal') {
      entries.push({ type: 'context', text: a[ai++] })
      bi++
    } else if (op === 'del') {
      entries.push({ type: 'del', text: a[ai++] })
    } else {
      entries.push({ type: 'add', text: b[bi++] })
    }
  }

  const changedIdx: number[] = []
  for (let idx = 0; idx < entries.length; idx++) {
    if (entries[idx].type !== 'context') changedIdx.push(idx)
  }
  if (changedIdx.length === 0) return { blocks: [], added: 0, deleted: 0 }

  const keep = new Set<number>()
  for (const ci of changedIdx) {
    const from = Math.max(0, ci - CONTEXT_LINES)
    const to = Math.min(entries.length - 1, ci + CONTEXT_LINES)
    for (let k = from; k <= to; k++) keep.add(k)
  }

  const blocks: DiffBlock[] = []
  let added = 0
  let deleted = 0
  let current: DiffLine[] = []
  let prev = -1
  for (const idx of [...keep].sort((x, y) => x - y)) {
    if (idx > prev + 1) {
      if (current.length > 0) blocks.push({ kind: 'hunk', lines: current })
      current = []
      blocks.push({ kind: 'gap', count: idx - prev - 1 })
    }
    const entry = entries[idx]
    current.push(entry)
    if (entry.type === 'add') added++
    if (entry.type === 'del') deleted++
    prev = idx
  }
  if (current.length > 0) blocks.push({ kind: 'hunk', lines: current })
  return { blocks, added, deleted }
}
