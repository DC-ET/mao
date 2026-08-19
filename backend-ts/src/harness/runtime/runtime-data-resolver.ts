import path from 'node:path';

const LOCAL_RUNTIME_PREFIX = '~/.mao/runtime';
const LOCAL_UNSYNCED_SKILLS_PREFIX = '~/.agents/skills';

export class RuntimeDataResolver {
  readonly runtimeRoot: string;
  readonly userHomeRoot: string;

  constructor(runtimeDir: string, userHomeDir: string) {
    this.runtimeRoot = path.resolve(runtimeDir);
    this.userHomeRoot = path.resolve(userHomeDir);
  }

  static forTest(runtimeDir: string, userHomeDir: string): RuntimeDataResolver {
    return new RuntimeDataResolver(runtimeDir, userHomeDir);
  }

  resolveSessionRuntimeDir(userId: number, sessionId: number): string {
    return path.join(this.runtimeRoot, String(userId), String(sessionId));
  }

  resolveSkillsDir(userId: number, sessionId: number): string {
    return path.join(this.resolveSessionRuntimeDir(userId, sessionId), 'skills');
  }

  resolveShellOutputDir(userId: number, sessionId: number): string {
    return path.join(this.resolveSessionRuntimeDir(userId, sessionId), 'shellOutput');
  }

  resolveIncomingDir(userId: number, sessionId: number): string {
    return path.join(this.resolveSessionRuntimeDir(userId, sessionId), 'incoming');
  }

  resolveGitAskpassScript(userId: number, sessionId: number): string {
    return path.join(this.resolveSessionRuntimeDir(userId, sessionId), 'git-askpass.sh');
  }

  resolveUserHomeDir(userId: number | null | undefined): string | null {
    if (userId == null) return null;
    return path.join(this.userHomeRoot, String(userId));
  }

  formatLocalSkillsPath(sessionId: number, skillName: string): string {
    return `${LOCAL_RUNTIME_PREFIX}/${sessionId}/skills/${skillName}/SKILL.md`;
  }

  formatLocalSkillsDir(sessionId: number, skillName: string): string {
    return `${LOCAL_RUNTIME_PREFIX}/${sessionId}/skills/${skillName}`;
  }

  formatCloudSkillsPath(userId: number, sessionId: number, skillName: string): string {
    return path.join(this.resolveSkillsDir(userId, sessionId), skillName, 'SKILL.md');
  }

  formatCloudSkillsDir(userId: number, sessionId: number, skillName: string): string {
    return path.join(this.resolveSkillsDir(userId, sessionId), skillName);
  }

  getRuntimeRoot(): string {
    return this.runtimeRoot;
  }

  getUserHomeRoot(): string {
    return this.userHomeRoot;
  }

  formatLocalUnsyncedSkillsPath(folderName: string): string {
    return `${LOCAL_UNSYNCED_SKILLS_PREFIX}/${folderName}/SKILL.md`;
  }

  formatLocalUnsyncedSkillsDir(folderName: string): string {
    return `${LOCAL_UNSYNCED_SKILLS_PREFIX}/${folderName}`;
  }
}
