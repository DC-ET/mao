/**
 * 工具卡片富视图的解析层（0.0.468）：图片生成 / 问答回放 / 子代理进度三个新视图的
 * 数据解析与组装抽成纯函数，SFC computed 只做接线（与既有 8 个富视图同模式，
 * ToolCallCard 已 1000+ 行不再内联）。形状契约见各函数注释：
 * - generate_image / edit_image 结果 {images:[{image_url,image_path,size_bytes,source,mime}],model,size,prompt}
 * - ask_user_questions 结果 {answers:[{question,selectedLabels,customInput}]}
 * - check_subagent / wait_subagents(超时分支) 的 BackgroundProgress
 */

/** 图片网格单次渲染上限（3×3，长会话滚动性能护栏），超出渲染前 9 张并显示尾行提示。 */
export const MAX_IMAGE_ITEMS = 9

export interface ImageGenItem {
  url: string
  path: string
  /** 角标字节数文案（如 12KB）；size_bytes 非有限数时为空串不给角标 */
  bytesLabel: string
  /** mime 大写角标（如 PNG）；未知 mime 为空串 */
  mimeTag: string
}

export interface ImageGenViewData {
  prompt: string
  model: string
  size: string
  items: ImageGenItem[]
  /** 渲染上限之外的数量（共 N 张时为 N - 9） */
  hiddenCount: number
}

/** 字节数文案：B/KB/MB，Math.floor 口径与后端 tool-result-summarizer 的 formatFileSize 一致。 */
export function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.floor(bytes / 1024)}KB`
  return `${Math.floor(bytes / (1024 * 1024))}MB`
}

const MIME_TAG_MAP: Record<string, string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WEBP',
  'image/gif': 'GIF',
}

/**
 * 图片生成结果解析：images 为非空数组且首项含非空 string image_url 才产出视图，
 * 否则返回 null 回落原始 JSON（空 images / 非数组 / 解析失败）。
 * items 截前 MAX_IMAGE_ITEMS 张，hiddenCount = 总数 - 上限。
 */
export function parseImageGenItems(node: Record<string, unknown> | null): ImageGenViewData | null {
  if (!node) return null
  const rawImages = node.images
  if (!Array.isArray(rawImages) || rawImages.length === 0) return null
  const first = rawImages[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  const firstUrl = (first as Record<string, unknown>).image_url
  if (typeof firstUrl !== 'string' || firstUrl === '') return null
  const items: ImageGenItem[] = []
  for (const raw of rawImages) {
    if (items.length >= MAX_IMAGE_ITEMS) break
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const url = typeof entry.image_url === 'string' ? entry.image_url : ''
    if (!url) continue
    const sizeBytes = entry.size_bytes
    const bytesLabel = typeof sizeBytes === 'number' && Number.isFinite(sizeBytes) && sizeBytes > 0
      ? formatImageBytes(sizeBytes)
      : ''
    const mime = typeof entry.mime === 'string' ? entry.mime : ''
    const mimeTag = MIME_TAG_MAP[mime.toLowerCase()] ?? ''
    const path = typeof entry.image_path === 'string' ? entry.image_path : ''
    items.push({ url, path, bytesLabel, mimeTag })
  }
  return {
    prompt: typeof node.prompt === 'string' ? node.prompt : '',
    model: typeof node.model === 'string' ? node.model : '',
    size: typeof node.size === 'string' ? node.size : '',
    items,
    hiddenCount: Math.max(0, rawImages.length - MAX_IMAGE_ITEMS),
  }
}

export interface AskUserPair {
  question: string
  labels: string[]
  customInput: string
}

/**
 * 问答回放解析：answers 逐项取 question / selectedLabels / customInput，
 * question 非空才收；无有效问答对（空数组 / 缺 answers / node 为空）返回 null 回落原始 JSON。
 */
export function parseAskUserPairs(node: Record<string, unknown> | null): AskUserPair[] | null {
  if (!node) return null
  const raw = node.answers
  if (!Array.isArray(raw)) return null
  const pairs: AskUserPair[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const question = typeof entry.question === 'string' ? entry.question : ''
    if (!question) continue
    const labels = Array.isArray(entry.selectedLabels)
      ? entry.selectedLabels.filter((l): l is string => typeof l === 'string')
      : []
    const customInput = typeof entry.customInput === 'string' ? entry.customInput : ''
    pairs.push({ question, labels, customInput })
  }
  return pairs.length > 0 ? pairs : null
}

export type SubagentStatusKind = 'running' | 'ok' | 'fail' | 'muted'

export interface SubagentProgressRow {
  taskId: number | null
  agentType: string
  status: string
  statusKind: SubagentStatusKind
  /** 由非空字段拼的统计行：N 轮 / M 次工具 / X+Y tok */
  stats: string
  recentOutput: string
}

/** status → 徽标种类：RUNNING→running / COMPLETED→ok / FAILED→fail / 其余（含 CANCELLED）→muted。 */
function statusKindOf(status: string): SubagentStatusKind {
  switch (status.toUpperCase()) {
    case 'RUNNING':
      return 'running'
    case 'COMPLETED':
      return 'ok'
    case 'FAILED':
      return 'fail'
    default:
      return 'muted'
  }
}

function progressStats(entry: Record<string, unknown>): string {
  const parts: string[] = []
  const rounds = entry.totalRounds
  if (typeof rounds === 'number' && Number.isFinite(rounds)) parts.push(`${rounds} 轮`)
  const toolCalls = entry.totalToolCalls
  if (typeof toolCalls === 'number' && Number.isFinite(toolCalls)) parts.push(`${toolCalls} 次工具`)
  const prompt = entry.totalPromptTokens
  const completion = entry.totalCompletionTokens
  const hasPrompt = typeof prompt === 'number' && Number.isFinite(prompt)
  const hasCompletion = typeof completion === 'number' && Number.isFinite(completion)
  if (hasPrompt && hasCompletion) parts.push(`${prompt}+${completion} tok`)
  else if (hasPrompt) parts.push(`${prompt} tok`)
  else if (hasCompletion) parts.push(`${completion} tok`)
  return parts.join(' / ')
}

/**
 * 子代理进度行解析：接受 background_subagents 数组形态（check_subagent 无参形态与
 * wait_subagents 超时分支）与单对象形态（taskId 或 status 键存在时包成单元素数组，
 * check_subagent 带 task_id 的返回）。无可渲染行返回 null 回落原始 JSON。
 */
export function parseSubagentProgressRows(node: Record<string, unknown> | null): SubagentProgressRow[] | null {
  if (!node) return null
  let list: unknown[]
  if (Array.isArray(node.background_subagents)) {
    list = node.background_subagents
  } else if ('taskId' in node || 'status' in node) {
    list = [node]
  } else {
    return null
  }
  const rows: SubagentProgressRow[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const taskId = typeof entry.taskId === 'number' && Number.isFinite(entry.taskId) ? entry.taskId : null
    const agentType = typeof entry.agentType === 'string' ? entry.agentType : ''
    const status = typeof entry.status === 'string' ? entry.status : ''
    const recentOutput = typeof entry.recentOutput === 'string' ? entry.recentOutput : ''
    rows.push({
      taskId,
      agentType,
      status,
      statusKind: statusKindOf(status),
      stats: progressStats(entry),
      recentOutput,
    })
  }
  return rows.length > 0 ? rows : null
}
