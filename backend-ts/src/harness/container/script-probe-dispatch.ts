import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executeScriptProbe, type ScriptProbeResult } from '../../signal/script-probe.js';
import { ASKPASS, gitTokenEnvKey } from '../../common/git-askpass.js';
import { isReservedEnvKey } from '../../common/sensitive-env.js';
import { isUnder } from '../safety/path-sandbox.js';
import type { ScriptProbeFrameCredentials, ScriptProbeFrameDeps, ScriptProbeFrameEnv } from './runtime-channel-protocol.js';

/**
 * 容器内执行脚本探针（docs/plan/2026-11-10-script-probe-container-isolation-technical-design.md §4 步骤 2）。
 *
 * 身份与根目录只读本容器启动时注入的 env，不读帧里的 userId。子进程 env 白名单重建，
 * 不展开 runtime-agent 的 process.env（里面有 MAO_CHANNEL_TOKEN）。
 *
 * 凭据（2026-11-20 起）：帧 credentials 携带宿主现取的用户凭据（与 agent shell 同注入面），
 * 白名单校验后并入子进程 env；askpass 落容器私有 /tmp 目录（shell-session-manager 容器模式
 * 同款先例），不与宿主运行时路径共用文件。credentials 缺省（旧宿主）时按无凭据运行。
 */

/** 模块加载时的镜像 PATH。帧里的 PATH 一律不用。 */
const CONTAINER_BASE_PATH = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface ScriptProbeDispatchRequest {
  scriptPath: string;
  timeoutSeconds: number;
  env: Partial<ScriptProbeFrameEnv> | null | undefined;
  deps: Partial<ScriptProbeFrameDeps> | null | undefined;
  credentials?: Partial<ScriptProbeFrameCredentials> | null | undefined;
}

export interface ScriptProbeDispatchResult {
  failureClass: 'script' | 'infrastructure';
  ok: boolean;
  exitCode: number | null;
  stdoutBase64: string | null;
  error: string | null;
  durationMs: number;
}

export async function dispatchScriptProbe(req: ScriptProbeDispatchRequest): Promise<ScriptProbeDispatchResult> {
  const userId = containerUserId();
  if (userId == null) return infrastructure('容器身份缺失');
  const workspaceRoot = process.env.MAO_WORKSPACE_ROOT;
  if (workspaceRoot == null || workspaceRoot.trim() === '') return infrastructure('容器工作区根缺失');
  const watcherId = readString(req.env, 'MAO_WATCHER_ID');
  const watcherName = readString(req.env, 'MAO_WATCHER_NAME');
  if (watcherId == null || watcherId === '' || watcherName == null || watcherName === '') return infrastructure('探针参数不完整');
  if (req.scriptPath.trim() === '' || !Number.isFinite(req.timeoutSeconds) || req.timeoutSeconds <= 0) {
    return infrastructure('探针参数不完整');
  }

  const projectsRoot = realpathOrNull(path.join(workspaceRoot, String(userId), 'projects'));
  const scriptReal = realpathOrNull(req.scriptPath);
  if (scriptReal == null) return scriptFailure(`脚本文件不存在：${req.scriptPath}`);
  if (projectsRoot == null || !isUnder(scriptReal, projectsRoot)) {
    return scriptFailure(`脚本路径越出项目工作区：${req.scriptPath}`);
  }
  try {
    if (!statSync(scriptReal).isFile()) return scriptFailure(`脚本路径不是文件：${req.scriptPath}`);
  } catch {
    return scriptFailure(`脚本文件不存在：${req.scriptPath}`);
  }

  const env = buildChildEnv(userId, watcherId, watcherName, req.env, req.deps, req.credentials);
  const result = await executeScriptProbe({ scriptPath: scriptReal, timeoutSeconds: req.timeoutSeconds, env });
  return fromScriptResult(result);
}

function buildChildEnv(
  userId: number,
  watcherId: string,
  watcherName: string,
  frameEnv: Partial<ScriptProbeFrameEnv> | null | undefined,
  deps: Partial<ScriptProbeFrameDeps> | null | undefined,
  credentials: Partial<ScriptProbeFrameCredentials> | null | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: containerPath(userId, deps),
    MAO_WATCHER_ID: watcherId,
    MAO_WATCHER_NAME: watcherName,
  };
  const home = readString(frameEnv, 'HOME');
  const homeRoot = process.env.MAO_USER_HOME_DIR;
  if (home != null && home !== '' && homeRoot != null && homeRoot !== '') {
    const realHome = realpathOrNull(home);
    const realRoot = realpathOrNull(path.join(homeRoot, String(userId)));
    if (realHome != null && realRoot != null && isUnder(realHome, realRoot)) env.HOME = realHome;
  }
  const tz = readString(frameEnv, 'TZ');
  if (tz != null && tz !== '' && tz.length <= 64 && !tz.includes('\n') && !tz.includes('\0')) env.TZ = tz;
  const depsRoot = process.env.MAO_DEPS_DIR;
  if (depsRoot != null && depsRoot !== '') {
    const prefix = acceptedDepsPath(userId, depsRoot, readString(deps, 'NPM_CONFIG_PREFIX'));
    const pip = acceptedDepsPath(userId, depsRoot, readString(deps, 'PIP_TARGET'));
    if (prefix != null) env.NPM_CONFIG_PREFIX = prefix;
    if (pip != null) env.PIP_TARGET = pip;
    if (readString(deps, 'PIP_BREAK_SYSTEM_PACKAGES') === '1') env.PIP_BREAK_SYSTEM_PACKAGES = '1';
  }
  applyScriptCredentials(userId, env, credentials);
  return env;
}

/**
 * 帧凭据并入子进程 env（与 agent shell 同注入面）。值逐键做 string 白名单校验，违规
 * 丢键照常跑；envVars 再过一道 isReservedEnvKey（宿主已过滤，此处双保险防宿主/库漂移），
 * 保证用户自配变量覆盖不了 PATH/HOME/凭据等身份键。
 */
function applyScriptCredentials(
  userId: number,
  env: Record<string, string>,
  credentials: Partial<ScriptProbeFrameCredentials> | null | undefined,
): void {
  if (credentials == null) return;
  const gitTokens = credentials.gitTokens;
  if (gitTokens != null && typeof gitTokens === 'object') {
    let count = 0;
    for (const [domain, token] of Object.entries(gitTokens)) {
      if (domain === '' || typeof token !== 'string' || token === '') continue;
      env[gitTokenEnvKey(domain)] = token;
      count += 1;
    }
    if (count > 0) {
      const askpass = writeContainerAskpass(userId);
      if (askpass != null) {
        env.GIT_ASKPASS = askpass;
        env.GIT_TERMINAL_PROMPT = '0';
      }
    }
  }
  if (isNonEmptyString(credentials.maoToken)) env.MAO_TOKEN = credentials.maoToken;
  if (isNonEmptyString(credentials.ecpToken)) env.ECP_TOKEN = credentials.ecpToken;
  if (isNonEmptyString(credentials.maoBaseUrl)) env.MAO_BASE_URL = credentials.maoBaseUrl;
  const larkUat = credentials.larkUat;
  if (larkUat != null && typeof larkUat === 'object') {
    if (isNonEmptyString(larkUat.uat)) env.LARKSUITE_CLI_USER_ACCESS_TOKEN = larkUat.uat;
    if (isNonEmptyString(larkUat.appId)) env.LARKSUITE_CLI_APP_ID = larkUat.appId;
  }
  const envVars = credentials.envVars;
  if (envVars != null && typeof envVars === 'object') {
    for (const [key, value] of Object.entries(envVars)) {
      if (key === '' || typeof value !== 'string' || isReservedEnvKey(key)) continue;
      env[key] = value;
    }
  }
}

/** 容器内 askpass 私有落点：/tmp 按用户隔离目录（shell-session-manager 容器模式同款），写失败降级为无 askpass。 */
function writeContainerAskpass(userId: number): string | null {
  try {
    const dir = path.join('/tmp', `askpass-${userId}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const script = path.join(dir, 'watcher-askpass.sh');
    writeFileSync(script, ASKPASS, { mode: 0o700 });
    return script;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function containerPath(userId: number, deps: Partial<ScriptProbeFrameDeps> | null | undefined): string {
  const depsRoot = process.env.MAO_DEPS_DIR;
  const bin = depsRoot == null || depsRoot === ''
    ? null
    : acceptedDepsPath(userId, depsRoot, readString(deps, 'MAO_DEPS_BIN'));
  const base = CONTAINER_BASE_PATH.split(path.delimiter).filter((seg) => seg !== '' && seg !== bin);
  if (bin == null) return base.join(path.delimiter);
  return [bin, ...base].join(path.delimiter);
}

/** realpath 后落在本人 deps 目录内才接受；否则丢掉该键，探针照常跑。 */
function acceptedDepsPath(userId: number, depsRoot: string, candidate: string | undefined): string | null {
  if (candidate == null || candidate === '') return null;
  const root = realpathOrNull(path.join(depsRoot, String(userId)));
  const real = realpathOrNull(candidate);
  if (root == null || real == null || !isUnder(real, root)) return null;
  return real;
}

function containerUserId(): number | null {
  const raw = process.env.MAO_CONTAINER_USER_ID;
  if (raw == null || !/^\d+$/.test(raw)) return null;
  const userId = Number(raw);
  return userId > 0 ? userId : null;
}

function readString(record: object | null | undefined, key: string): string | undefined {
  if (record == null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function realpathOrNull(target: string): string | null {
  try {
    return realpathSync(target);
  } catch {
    return null;
  }
}

function fromScriptResult(result: ScriptProbeResult): ScriptProbeDispatchResult {
  return {
    failureClass: 'script',
    ok: result.ok,
    exitCode: result.exitCode,
    stdoutBase64: result.stdoutBytes == null ? null : result.stdoutBytes.toString('base64'),
    error: result.error,
    durationMs: result.durationMs,
  };
}

function infrastructure(error: string): ScriptProbeDispatchResult {
  return { failureClass: 'infrastructure', ok: false, exitCode: null, stdoutBase64: null, error, durationMs: 0 };
}

function scriptFailure(error: string): ScriptProbeDispatchResult {
  return { failureClass: 'script', ok: false, exitCode: null, stdoutBase64: null, error, durationMs: 0 };
}
