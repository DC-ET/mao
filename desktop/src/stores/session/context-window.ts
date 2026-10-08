import type { ContextManifest, ContextWindowInfo } from '../../types/chat'

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
