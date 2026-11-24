import type { GitLogEntry } from '../types/git'

/** 图谱最多可见列数：更右侧的列钳到最后一列绘制（圆点改空心并提示隐藏条数）。 */
export const GRAPH_MAX_LANES = 10
/** 颜色序号循环数，对应 GitGraphCell 的 8 色调色板。 */
export const GRAPH_COLOR_COUNT = 8

/** 一段连线：from / to 是列号。行上半段 = 上边沿 → 行中线；行下半段 = 行中线 → 下边沿。 */
export interface GitGraphSegment {
  from: number
  to: number
  color: number
}

export interface GitGraphLane {
  lane: number
  color: number
}

export interface GitGraphRow {
  /** 本提交圆点所在列 */
  lane: number
  color: number
  isMerge: boolean
  top: GitGraphSegment[]
  bottom: GitGraphSegment[]
  /** 下边沿仍在等待父提交的列（展开文件清单时画穿行竖线） */
  passLanes: GitGraphLane[]
}

export interface GitGraph {
  rows: GitGraphRow[]
  /** 用到的最大列号 + 1（未钳制） */
  laneCount: number
}

/**
 * 单遍分道：输入必须是 `--date-order` 顺序（子提交先于全部父提交）。
 * 列一旦分配直到释放前不左移；释放后新分支优先复用最左空列。
 * 父提交不在 entries 内（未翻到、浅克隆、范围外）时，该列一直延伸到最后一行下边沿。
 */
export function computeGitGraph(entries: GitLogEntry[]): GitGraph {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  let laneCount = 0
  const rows: GitGraphRow[] = []

  const newColor = () => nextColor++ % GRAPH_COLOR_COUNT
  const freeLane = () => {
    const i = lanes.indexOf(null)
    return i >= 0 ? i : lanes.length
  }

  for (const entry of entries) {
    const parents = entry.parents ?? []
    const top: GitGraphSegment[] = []
    const pass: number[] = []
    let lane = -1
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === entry.hash && lane < 0) lane = i
    }
    let color: number
    if (lane >= 0) {
      color = colors[lane]
    } else {
      lane = freeLane()
      color = newColor()
    }

    for (let i = 0; i < lanes.length; i++) {
      const waiting = lanes[i]
      if (waiting == null) continue
      if (waiting === entry.hash) {
        top.push({ from: i, to: lane, color: colors[i] })
        lanes[i] = null
      } else {
        top.push({ from: i, to: i, color: colors[i] })
        pass.push(i)
      }
    }

    const bottom: GitGraphSegment[] = pass.map((i) => ({ from: i, to: i, color: colors[i] }))
    const assign = (i: number, hash: string, c: number) => {
      while (lanes.length <= i) {
        lanes.push(null)
        colors.push(0)
      }
      lanes[i] = hash
      colors[i] = c
    }

    parents.forEach((parent, index) => {
      const existing = lanes.indexOf(parent)
      if (existing >= 0) {
        bottom.push({ from: lane, to: existing, color: index === 0 ? color : colors[existing] })
        return
      }
      if (index === 0) {
        assign(lane, parent, color)
        bottom.push({ from: lane, to: lane, color })
        return
      }
      const target = freeLane()
      const c = newColor()
      assign(target, parent, c)
      bottom.push({ from: lane, to: target, color: c })
    })

    while (lanes.length > 0 && lanes[lanes.length - 1] == null) {
      lanes.pop()
      colors.pop()
    }

    for (const s of [...top, ...bottom]) laneCount = Math.max(laneCount, s.from + 1, s.to + 1)
    laneCount = Math.max(laneCount, lane + 1)

    const passLanes: GitGraphLane[] = []
    lanes.forEach((hash, i) => {
      if (hash != null) passLanes.push({ lane: i, color: colors[i] })
    })

    rows.push({ lane, color, isMerge: parents.length > 1, top, bottom, passLanes })
  }

  return { rows, laneCount }
}

/** 渲染列号：超出可见上限的列画在最后一列。 */
export function visibleLane(lane: number): number {
  return Math.min(lane, GRAPH_MAX_LANES - 1)
}

/** 本行因超出可见上限而叠画在最后一列的列数（不含最后一列本身）。 */
export function hiddenLaneCount(row: GitGraphRow): number {
  const hidden = new Set<number>()
  for (const s of [...row.top, ...row.bottom]) {
    if (s.from >= GRAPH_MAX_LANES) hidden.add(s.from)
    if (s.to >= GRAPH_MAX_LANES) hidden.add(s.to)
  }
  if (row.lane >= GRAPH_MAX_LANES) hidden.add(row.lane)
  return hidden.size
}

const MERGE_PATTERNS: Array<{ re: RegExp; format: (m: RegExpExecArray) => string }> = [
  {
    re: /^Merge (?:remote-tracking )?branch '([^']+)'(?: of \S+)?(?: into '?([^']+?)'?)?$/,
    format: (m) => `${m[1]} → ${m[2] ?? '(当前)'}`,
  },
  {
    re: /^Merge pull request (#\d+) from (\S+)$/,
    format: (m) => `${m[1]} ${m[2]}`,
  },
]

/**
 * 合并提交标题简化：只认 git / GitHub / GitLab 的默认合并标题，返回「A → B」或「#N 分支」；
 * 不认识的格式返回 null（调用方原样显示）。调用方负责只对多父提交调用。
 */
export function parseMergeTitle(title: string): string | null {
  const trimmed = title.trim()
  for (const { re, format } of MERGE_PATTERNS) {
    const m = re.exec(trimmed)
    if (m) return format(m)
  }
  return null
}
