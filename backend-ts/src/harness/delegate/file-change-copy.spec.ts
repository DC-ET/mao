import { describe, expect, it } from 'vitest';
import { fileChangeCopyKey, fileChangesAfterMessage } from './file-change-copy.js';
import type { FileChange } from '../../session/types.js';

function change(partial: Partial<FileChange>): FileChange {
  return { messageId: 1, sessionId: 1, filePath: 'a.ts', changeType: 'MODIFIED', linesAdded: 1, linesDeleted: 0, ...partial };
}

describe('fileChangesAfterMessage', () => {
  it('keeps only changes created after the execution start message', () => {
    const changes = [
      change({ id: 1, messageId: 10, patchContent: 'old' }),
      change({ id: 2, messageId: 20, patchContent: 'new' }),
    ];
    expect(fileChangesAfterMessage(changes, 10).map((item) => item.id)).toEqual([2]);
    expect(fileChangesAfterMessage(changes, null)).toHaveLength(2);
  });

  it('treats identical diffs as the same copy key', () => {
    const first = change({ patchContent: 'diff', beforeContent: 'a', afterContent: 'b' });
    const again = change({ messageId: 30, patchContent: 'diff', beforeContent: 'a', afterContent: 'b' });
    const edited = change({ patchContent: 'other' });
    expect(fileChangeCopyKey(first)).toBe(fileChangeCopyKey(again));
    expect(fileChangeCopyKey(first)).not.toBe(fileChangeCopyKey(edited));
  });
});
