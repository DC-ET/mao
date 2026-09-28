import type { FileChange } from '../../session/types.js';

/** 同一次复制里用来识别「已经写过的同一份变更」，避免 followup/重试把旧 diff 再写进父会话。 */
export function fileChangeCopyKey(change: FileChange): string {
  const filePath = change.filePath ?? (change as { path?: string }).path ?? '';
  const changeType = change.changeType ?? (change as { type?: string }).type ?? '';
  return [
    filePath,
    changeType,
    change.linesAdded ?? '',
    change.linesDeleted ?? '',
    change.patchContent ?? '',
    change.beforeContent ?? '',
    change.afterContent ?? '',
  ].join('\0');
}

/** afterMessageId 是本轮 execution 的起始用户消息。只带走这之后新增的变更。 */
export function fileChangesAfterMessage(
  changes: FileChange[],
  afterMessageId: number | null | undefined,
): FileChange[] {
  if (afterMessageId == null) return changes;
  return changes.filter((change) => change.messageId != null && change.messageId > afterMessageId);
}
