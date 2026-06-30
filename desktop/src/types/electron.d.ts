interface TerminalCreateOptions {
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
}

interface TerminalCreateResult {
  id: string
  shell: string
  cwd: string
}

interface TerminalDataPayload {
  id: string
  data: string
}

interface TerminalExitPayload {
  id: string
  exitCode: number
}

interface WorkspaceFile {
  path: string
  name: string
  size: number
}

interface DirectoryEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: number
  isSymlink: boolean
}

interface DirectoryResult {
  entries?: DirectoryEntry[]
  error?: string
  truncated?: boolean
}

interface LocalSkillDoc {
  folderName: string
  name: string
  description: string
  folderPath: string
}

interface LocalSkillListResult {
  skills?: LocalSkillDoc[]
  skillsDir?: string
  error?: string
}

interface LocalSkillFileEntry {
  relativePath: string
  base64: string
}

interface LocalSkillFilesResult {
  folderName?: string
  files?: LocalSkillFileEntry[]
  error?: string
}

interface LocalSkillDetail {
  folderName: string
  name: string
  description: string
  body: string
  folderPath: string
  filePath: string
}

interface ElectronAPI {
  getAppVersion(): Promise<string>
  getPlatform(): Promise<string>
  getEnvironmentInfo(workspace?: string): Promise<{
    isGit: boolean
    platform: string
    shell: string
    osVersion: string
  }>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>
  openExternal(url: string): Promise<void>
  selectDirectory(): Promise<string | null>
  openFolder(folderPath: string): Promise<void>
  openTerminal(folderPath: string): Promise<void>
  showItemInFolder(fullPath: string): Promise<void>

  toolExecute(toolName: string, args: any, requestId: string, workspace: string, sessionId: string, needApproval: boolean, dangerReason?: string): Promise<any>
  localReadFile(args: any): Promise<any>
  localWriteFile(args: any): Promise<any>
  localEditFile(args: any): Promise<any>
  listWorkspaceFiles(workspace: string, filter?: string, limit?: number): Promise<WorkspaceFile[]>
  listDirectory(dirPath: string, workspace: string): Promise<DirectoryResult>

  onToolApprovalRequest(callback: (data: any) => void): void
  removeToolApprovalRequestListener(): void
  onToolApprovalDismiss(callback: (data: any) => void): void
  removeToolApprovalDismissListener(): void
  respondToolApproval(requestId: string, approved: boolean): Promise<void>

  skillSync(sessionId: number, syncUrl: string, token: string, workspace: string): Promise<any>
  onSkillSyncComplete(callback: (data: any) => void): void
  removeSkillSyncCompleteListener(): void

  listLocalSkills(): Promise<LocalSkillListResult>
  getLocalSkillDetail(folderName: string): Promise<LocalSkillDetail | { error: string }>
  readLocalSkillFiles(folderName: string): Promise<LocalSkillFilesResult>

  terminal: {
    create(options: TerminalCreateOptions): Promise<TerminalCreateResult>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): Promise<void>
    list(): Promise<Array<{ id: string; shell: string; cwd: string; createdAt: number }>>
    onData(callback: (payload: TerminalDataPayload) => void): () => void
    onExit(callback: (payload: TerminalExitPayload) => void): () => void
  }
}

declare interface Window {
  electronAPI: ElectronAPI
}
