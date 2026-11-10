import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { executeScriptProbe, type ScriptProbeResult } from '../../signal/script-probe.js';
import { isUnder } from '../safety/path-sandbox.js';
import type { ScriptProbeFrameDeps, ScriptProbeFrameEnv } from './runtime-channel-protocol.js';

/**
 * 容器内执行脚本探针（docs/plan/2026-11-10-script-probe-container-isolation-technical-design.md §4 步骤 2）。
 *
 * 身份与根目录只读本容器启动时注入的 env，不读帧里的 userId。子进程 env 白名单重建，
 * 不展开 runtime-agent 的 process.env（里面有 MAO_CHANNEL_TOKEN）。
 */

/** 模块加载时的镜像 PATH。帧里的 PATH 一律不用。 */
const CONTAINER_BASE_PATH = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export interface ScriptProbeDispatchRequest {
  scriptPath: string;
  timeoutSeconds: number;
  env: Partial<ScriptProbeFrameEnv> | null | undefined;
  deps: Partial<ScriptProbeFrameDeps> | null | undefined;
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

  const env = buildChildEnv(userId, watcherId, watcherName, req.env, req.deps);
  const result = await executeScriptProbe({ scriptPath: scriptReal, timeoutSeconds: req.timeoutSeconds, env });
  return fromScriptResult(result);
}

function buildChildEnv(
  userId: number,
  watcherId: string,
  watcherName: string,
  frameEnv: Partial<ScriptProbeFrameEnv> | null | undefined,
  deps: Partial<ScriptProbeFrameDeps> | null | undefined,
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
  return env;
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
