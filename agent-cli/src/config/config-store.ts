import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BASE_URL, type OutputFormat, type PermissionLevel } from '../args';

export interface AgentCliConfigFile {
  baseUrl?: string;
  defaultAgentId?: number | null;
  defaultModelId?: number | null;
  permissionLevel?: PermissionLevel;
  outputFormat?: OutputFormat;
  lastSessionId?: number | null;
  trustedWorkspaces?: string[];
  ui?: {
    verboseTools?: boolean;
    showTurnDividers?: boolean;
    asciiOnly?: boolean;
    queuedInput?: boolean;
  };
}

export const CONFIG_DIR = path.join(os.homedir(), '.mao', 'agent-cli');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const RUNTIME_DIR = path.join(CONFIG_DIR, 'runtime');

function readJson<T>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string, mode: number): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode });
  }
}

function envBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return undefined;
}

export function findProjectConfig(startDir = process.cwd()): AgentCliConfigFile | null {
  let dir = path.resolve(startDir);
  const home = os.homedir();
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.mao', 'agent.json');
    if (fs.existsSync(candidate)) return readJson<AgentCliConfigFile>(candidate);
    const isGitRoot = fs.existsSync(path.join(dir, '.git'));
    if (isGitRoot || dir === home || dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function loadUserConfig(): AgentCliConfigFile {
  return readJson<AgentCliConfigFile>(CONFIG_FILE) ?? {};
}

export function saveUserConfig(patch: Partial<AgentCliConfigFile>): AgentCliConfigFile {
  ensureDir(CONFIG_DIR, 0o700);
  const current = loadUserConfig();
  const next = { ...current, ...patch };
  // 原子写：多个 mao-agent 进程可能同时追加 trustedWorkspaces / lastSessionId，
  // 直接就地写会在中途崩溃时留下截断的 JSON（下次 readJson 静默回落成 {}，信任列表整体丢失）。
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(tmp, CONFIG_FILE);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw e;
  }
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // ignore
  }
  return next;
}

export function rememberLastSession(sessionId: number): void {
  saveUserConfig({ lastSessionId: sessionId });
}

export interface ResolvedUi {
  verboseTools: boolean;
  showTurnDividers: boolean;
  asciiOnly: boolean;
  queuedInput: boolean;
}

export interface ResolvedConfig {
  baseUrl: string;
  defaultAgentId?: number;
  defaultModelId?: number;
  permissionLevel: PermissionLevel;
  outputFormat: OutputFormat;
  lastSessionId?: number;
  ui: ResolvedUi;
}

/**
 * 优先级：命令行选项 > 环境变量 > 项目级配置 > 用户配置文件 > 内置默认值。
 */
export function resolveConfig(cli: {
  baseUrl?: string;
  permissionLevel?: PermissionLevel;
  outputFormat?: OutputFormat;
  verboseTools?: boolean;
  asciiOnly?: boolean;
  queuedInput?: boolean;
}): ResolvedConfig {
  const user = loadUserConfig();
  const project = findProjectConfig() ?? {};
  const envBase = process.env.MAO_AGENT_BASE_URL;
  const envFormat = process.env.MAO_AGENT_OUTPUT_FORMAT as OutputFormat | undefined;
  const envVerbose = envBool(process.env.MAO_AGENT_VERBOSE);
  const baseUrl = cli.baseUrl || envBase || project.baseUrl || user.baseUrl || DEFAULT_BASE_URL;
  return {
    baseUrl,
    defaultAgentId: project.defaultAgentId ?? user.defaultAgentId ?? undefined,
    defaultModelId: project.defaultModelId ?? user.defaultModelId ?? undefined,
    permissionLevel: cli.permissionLevel || project.permissionLevel || user.permissionLevel || 'READ_WRITE',
    outputFormat: cli.outputFormat || envFormat || project.outputFormat || user.outputFormat || 'text',
    lastSessionId: user.lastSessionId ?? undefined,
    ui: {
      verboseTools: cli.verboseTools ?? envVerbose ?? project.ui?.verboseTools ?? user.ui?.verboseTools ?? false,
      showTurnDividers: project.ui?.showTurnDividers ?? user.ui?.showTurnDividers ?? true,
      asciiOnly: cli.asciiOnly ?? project.ui?.asciiOnly ?? user.ui?.asciiOnly ?? false,
      queuedInput: cli.queuedInput ?? project.ui?.queuedInput ?? user.ui?.queuedInput ?? true,
    },
  };
}

const MAX_RUNTIME_SESSIONS = 20;
const MAX_RUNTIME_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function cleanupRuntimeDir(): void {
  if (!fs.existsSync(RUNTIME_DIR)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(RUNTIME_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const full = path.join(RUNTIME_DIR, e.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  dirs.forEach((d, i) => {
    const tooOld = now - d.mtime > MAX_RUNTIME_AGE_MS;
    const tooMany = i >= MAX_RUNTIME_SESSIONS;
    if (tooOld || tooMany) {
      try {
        fs.rmSync(d.full, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
}

export function appendTrace(file: string, event: unknown): void {
  const dir = path.dirname(file);
  ensureDir(dir, 0o700);
  fs.appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}
