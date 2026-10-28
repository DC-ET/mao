/**
 * 解析 FileChangeDiffUtil.buildUnifiedPatch 产出的 unified patch，重建出
 * original / modified 两份全文模型，供 Monaco diff 编辑器渲染。
 *
 * 超过 SNAPSHOT_LIMIT_BYTES（512KB）的文件后端只发 patch，不含前后全文，
 * 前端不能再把 patch 当纯文本展示。这里按 @@ hunk 头把增删行摆回真实行号，
 * 未变更区域用空行填充——模型行号即文件行号，行号、引用、首处变更跳转
 * 都与 SNAPSHOT 模式一致。
 *
 * 产出方固定为 backend buildUnifiedPatch / agent-cli files.ts / electron
 * main.cjs 三处同格式实现：段头 `--- a/<path>` + `+++ b/<path>`、hunk 头
 * `@@ -o,c +n,c @@`、行前缀空格 / `-` / `+`，不产 `\ No newline` 标记。
 * 容错只针对 256KB 截断的半截 hunk 和前端多次编辑合并时拼接的残留行。
 */

export interface PatchHunk {
  /** 1 起始的旧文件行号 */
  oldStart: number
  /** 1 起始的新文件行号 */
  newStart: number
  oldLines: string[]
  newLines: string[]
}

export interface PatchSegment {
  filePath: string | null
  hunks: PatchHunk[]
}

export interface ParsedPatch {
  segments: PatchSegment[]
}

const SEGMENT_OLD_HEAD = '--- a/'
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseUnifiedPatch(patch: string): ParsedPatch {
  const lines = patch.split(/\r?\n/)
  // patch 以 \n 结尾，split 出的末项空串不是内容行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const segments: PatchSegment[] = []
  let current: PatchSegment | null = null
  let hunk: PatchHunk | null = null

  const closeHunk = () => {
    if (hunk && current) {
      current.hunks.push(hunk)
      hunk = null
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 段头必须 `--- a/` 后紧跟 `+++ `：被删除的内容行以 `--` 开头时会长得和
    // 段头一模一样（删掉 "-- a/x" 得到 "--- a/x"），但它的下一行不是 +++
    if (line.startsWith(SEGMENT_OLD_HEAD) && (i === 0 || (lines[i + 1] ?? '').startsWith('+++ '))) {
      closeHunk()
      current = { filePath: line.slice(SEGMENT_OLD_HEAD.length), hunks: [] }
      segments.push(current)
      i++ // 跳过 +++ 行
      continue
    }

    const header = HUNK_HEADER.exec(line)
    if (header) {
      closeHunk()
      if (!current) {
        current = { filePath: null, hunks: [] }
        segments.push(current)
      }
      hunk = {
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        oldLines: [],
        newLines: [],
      }
      continue
    }

    if (!hunk) {
      // hunk 之外的行：聚合占位（[snapshot diff omitted...]）、截断标记
      // （...[diff truncated]）、合并拼接产生的空行，直接忽略
      continue
    }

    const prefix = line[0]
    if (prefix === ' ') {
      hunk.oldLines.push(line.slice(1))
      hunk.newLines.push(line.slice(1))
    } else if (prefix === '-') {
      hunk.oldLines.push(line.slice(1))
    } else if (prefix === '+') {
      hunk.newLines.push(line.slice(1))
    } else if (prefix !== '\\') {
      // 无法识别的行 = hunk 在此中断（截断或拼接残留），保留已解析部分
      closeHunk()
    }
  }
  closeHunk()

  return { segments }
}

/**
 * patch → original / modified 两份全文文本。未变更区填空行，行号与文件一致；
 * 文件多大都只承载 hunk 内的真实行，渲染成本与文件大小无关。
 */
export function buildPatchDiffModels(patch: string): { original: string; modified: string } {
  const { segments } = parseUnifiedPatch(patch)

  let oldEnd = 0
  let newEnd = 0
  for (const segment of segments) {
    for (const hunk of segment.hunks) {
      oldEnd = Math.max(oldEnd, hunk.oldStart - 1 + hunk.oldLines.length)
      newEnd = Math.max(newEnd, hunk.newStart - 1 + hunk.newLines.length)
    }
  }

  const original = new Array<string>(oldEnd).fill('')
  const modified = new Array<string>(newEnd).fill('')
  for (const segment of segments) {
    for (const hunk of segment.hunks) {
      place(original, hunk.oldStart - 1, hunk.oldLines)
      place(modified, hunk.newStart - 1, hunk.newLines)
    }
  }

  return { original: original.join('\n'), modified: modified.join('\n') }
}

function place(target: string[], at: number, lines: string[]): void {
  for (let i = 0; i < lines.length; i++) {
    const index = at + i
    if (index >= 0 && index < target.length) target[index] = lines[i]
  }
}
