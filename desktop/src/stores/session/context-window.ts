import type { ContextManifest, ContextWindowInfo } from '../../types/chat'

export interface CapacitySection {
  key: string
  tokens: number
}

/**
 * 构成明细按字节估算的比例，分摊到实际容量上。
 * 容量用模型真实占用，不改小去迁就估算。交接摘要已含在会话消息中，不参与合计。
 * 四舍五入的余数补给最大的一节，参与合计的分节之和严格等于容量。
 */
export function scaleSectionsToCapacity<T extends CapacitySection>(sections: T[], capacity: number): T[] {
  const target = Math.round(capacity)
  if (!sections.length || !Number.isFinite(capacity) || target <= 0) return sections
  const additiveIdx: number[] = []
  let rawSum = 0
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    if (section.key === 'handoff') continue
    if (!Number.isFinite(section.tokens) || section.tokens <= 0) continue
    additiveIdx.push(i)
    rawSum += section.tokens
  }
  if (rawSum <= 0 || rawSum === target) return sections

  const factor = target / rawSum
  const scaled = sections.map((section) => ({ ...section }))
  for (let i = 0; i < scaled.length; i++) {
    if (scaled[i].key !== 'handoff' || scaled[i].tokens <= 0) continue
    scaled[i] = { ...scaled[i], tokens: Math.max(0, Math.round(scaled[i].tokens * factor)) }
  }
  const parts = additiveIdx.map((i) => {
    const exact = sections[i].tokens * factor
    const floored = Math.floor(exact)
    return { i, floored, frac: exact - floored }
  })
  let leftover = target - parts.reduce((acc, row) => acc + row.floored, 0)
  parts.sort((a, b) => b.frac - a.frac || sections[b.i].tokens - sections[a.i].tokens)
  for (const row of parts) {
    const extra = leftover > 0 ? 1 : 0
    if (extra) leftover -= 1
    scaled[row.i] = { ...scaled[row.i], tokens: row.floored + extra }
  }
  return scaled
}

/** 刷新后用会话上的水位数字和构成快照还原抽屉。没有分节时只还原容量。 */
export function persistedContextWindow(
  tokens: number | null | undefined,
  manifest: ContextManifest | null | undefined,
): ContextWindowInfo | null {
  if (tokens == null || tokens <= 0) return null
  const info: ContextWindowInfo = { estimated: tokens, actual: 0 }
  if (manifest && Array.isArray(manifest.sections) && manifest.sections.length > 0) {
    info.manifest = manifest
  }
  return info
}
