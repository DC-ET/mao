import { harnessLog } from '../log.js';
import type { LocalSkillRef } from './skill-document.js';

const SAFE_FOLDER_NAME = /^[^/\\]+$/;

export class LocalSkillRegistry {
  private readonly reported = new Map<number, LocalSkillRef[]>();

  report(sessionId: number | null | undefined, skills: LocalSkillRef[] | null | undefined): void {
    if (sessionId == null) return;
    if (!skills || skills.length === 0) {
      this.reported.delete(sessionId);
      return;
    }
    const sanitized: LocalSkillRef[] = [];
    for (const ref of skills) {
      if (!ref?.name || ref.name.trim() === '') continue;
      if (!ref.folderName || ref.folderName.trim() === ''
        || ref.folderName.startsWith('.')
        || !SAFE_FOLDER_NAME.test(ref.folderName)) {
        harnessLog('warn', `Ignoring local skill with unsafe folderName: ${ref.folderName}`);
        continue;
      }
      sanitized.push(ref);
    }
    if (sanitized.length === 0) this.reported.delete(sessionId);
    else this.reported.set(sessionId, sanitized);
  }

  get(sessionId: number | null | undefined): LocalSkillRef[] {
    if (sessionId == null) return [];
    return this.reported.get(sessionId) ?? [];
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.reported.delete(sessionId);
  }
}
