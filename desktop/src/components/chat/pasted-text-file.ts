/**
 * 粘贴超长文本转待发附件（技术方案 2026-10-29）的纯函数内核。
 *
 * 用户粘贴大批量精确数据（如 1000+ 个用户 ID）时，把整段文本直接塞进消息里，
 * 模型必须复述这些数据才能交给工具处理，漏位/错位与压缩丢精度都会让结果失真。
 * 因此在粘贴时就把超长纯文本转成 `.txt` 待发附件：不插入编辑器，发送时走既有
 * 附件链路（CLOUD 上传 / LOCAL 本机写盘），Agent 用 read_file / grep_search /
 * shell 精确处理文件。
 *
 * 抽成纯函数是为了不依赖 DOM 也能单测判定分支（阈值、附件位上限、文件名序号）。
 */

/** 触发文件化的字符数阈值：粘贴文本长度 ≥ 该值即转附件。 */
export const PASTE_TEXT_FILE_THRESHOLD = 2000

/** 待发附件数量上限（与输入框既有「最多上传 10 个附件」一致）。 */
export const MAX_PENDING_ATTACHMENTS = 10

/**
 * 粘贴附件序号：模块级自增，跨 ChatInput 实例连续 —— 新建任务首条消息发出后
 * 输入框组件会重建（居中态 / 会话态是两个实例），组件内计数器会归零，
 * 同一会话第二段长文本就会与第一段同名（LOCAL 下曾因此覆盖旧附件）。
 */
let pastedTextSeq = 0

/** 分配下一个粘贴附件序号（调用方只在真正转附件时调用）。 */
export function nextPastedTextSeq(): number {
  pastedTextSeq += 1
  return pastedTextSeq
}

export type PasteTextPlan =
  /** 未达阈值：交还编辑器按普通粘贴处理（含 marker 语法转换）。 */
  | { kind: 'passthrough' }
  /** 达阈值但附件位已满：不吞掉用户文本，回落到普通粘贴并提示。 */
  | { kind: 'limit-reached' }
  /** 达阈值且有空位：调用方生成待发附件。 */
  | { kind: 'convert' }

/**
 * 判定一次纯文本粘贴是否转附件（不分配序号、不创建 File）。
 *
 * @param text 剪贴板里的 text/plain
 * @param pendingCount 当前待发附件数量
 */
export function planPastedText(
  text: string | null | undefined,
  pendingCount: number,
): PasteTextPlan {
  if (typeof text !== 'string' || text.length < PASTE_TEXT_FILE_THRESHOLD) return { kind: 'passthrough' }
  if (pendingCount >= MAX_PENDING_ATTACHMENTS) return { kind: 'limit-reached' }
  return { kind: 'convert' }
}

/** 生成待发附件：`pasted-text-{seq}.txt`，内容原样。 */
export function createPastedTextFile(text: string, seq: number): File {
  return new File([text], `pasted-text-${seq}.txt`, { type: 'text/plain' })
}
