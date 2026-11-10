import { newFrameId, type RuntimeResponseFrame, type ScriptProbeFrameDeps, type ScriptProbeFrameEnv } from './runtime-channel-protocol.js';
import { SCRIPT_PROBE_MAX_STDOUT_BYTES, type ScriptProbeResult } from '../../signal/script-probe.js';
import type { ContainerEntry } from './container-registry.js';
import type { ChannelConnection } from './runtime-channel-server.js';

/**
 * 宿主侧脚本探针桥（docs/plan/2026-11-10-script-probe-container-isolation-technical-design.md §4 步骤 4）。
 * Docker 模式把探针送进属主容器；失败抛 ScriptProbeInfrastructureError，调用方不得改在宿主执行。
 */

/** 通道开销余量。脚本自己的超时在容器内按配置起算，不含拉起容器的时间。 */
const FRAME_GRACE_MS = 15_000;

const ENV_KEYS = ['HOME', 'TZ', 'MAO_WATCHER_ID', 'MAO_WATCHER_NAME'] as const;

export class ScriptProbeInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptProbeInfrastructureError';
  }
}

export interface ContainerScriptProbeDeps {
  enabledFor(userId: number): Promise<boolean>;
  ensureRunning(userId: number, agentId: number): Promise<ContainerEntry>;
  scriptProbeRuntimeReady(entry: ContainerEntry): boolean;
  getConnection(userId: number, agentId: number): ChannelConnection | null;
  /** buildDepsEnv 的返回值。缺键时容器侧丢掉对应前缀，探针照常跑。 */
  depsEnvOf(userId: number): Record<string, string>;
}

export class ContainerScriptProbe {
  constructor(private readonly deps: ContainerScriptProbeDeps) {}

  enabledFor(userId: number): Promise<boolean> {
    return this.deps.enabledFor(userId);
  }

  async execute(input: {
    userId: number;
    agentId: number;
    scriptPath: string;
    timeoutSeconds: number;
    /** 宿主 scriptProbeEnv 的结果。本类丢掉 PATH，只转发白名单键。 */
    env: Record<string, string>;
  }): Promise<ScriptProbeResult> {
    let entry: ContainerEntry;
    try {
      entry = await this.deps.ensureRunning(input.userId, input.agentId);
    } catch (e) {
      throw new ScriptProbeInfrastructureError(`容器未就绪：${errorMessage(e)}`);
    }
    if (!this.deps.scriptProbeRuntimeReady(entry)) {
      throw new ScriptProbeInfrastructureError('容器运行时版本待升级，本轮跳过');
    }
    const connection = this.deps.getConnection(input.userId, input.agentId);
    if (connection == null) {
      throw new ScriptProbeInfrastructureError('容器运行时通道未连接');
    }
    let response: RuntimeResponseFrame;
    try {
      response = await connection.request({
        v: 1,
        type: 'script_probe',
        id: newFrameId('probe'),
        scriptPath: input.scriptPath,
        timeoutSeconds: input.timeoutSeconds,
        env: pickEnv(input.env),
        deps: toFrameDeps(this.deps.depsEnvOf(input.userId)),
      }, input.timeoutSeconds * 1000 + FRAME_GRACE_MS);
    } catch (e) {
      throw new ScriptProbeInfrastructureError(`容器通道无响应：${errorMessage(e)}`);
    }
    if (response.type !== 'script_probe_result' || (response.failureClass !== 'script' && response.failureClass !== 'infrastructure')) {
      throw new ScriptProbeInfrastructureError('容器返回了意外的响应');
    }
    if (response.failureClass === 'infrastructure') {
      throw new ScriptProbeInfrastructureError(response.error ?? '容器内脚本探针不可用');
    }
    return toScriptProbeResult(response);
  }
}

function toFrameDeps(raw: Record<string, string>): ScriptProbeFrameDeps {
  return {
    NPM_CONFIG_PREFIX: raw.NPM_CONFIG_PREFIX ?? '',
    PIP_TARGET: raw.PIP_TARGET ?? '',
    PIP_BREAK_SYSTEM_PACKAGES: raw.PIP_BREAK_SYSTEM_PACKAGES ?? '',
    MAO_DEPS_BIN: raw.MAO_DEPS_BIN ?? '',
  };
}

function pickEnv(source: Record<string, string>): ScriptProbeFrameEnv {
  const env: ScriptProbeFrameEnv = { MAO_WATCHER_ID: '', MAO_WATCHER_NAME: '' };
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function toScriptProbeResult(frame: Extract<RuntimeResponseFrame, { type: 'script_probe_result' }>): ScriptProbeResult {
  const durationMs = Number.isFinite(frame.durationMs) ? frame.durationMs : 0;
  if (frame.stdoutBase64 == null || frame.stdoutBase64 === '') {
    return {
      ok: frame.ok,
      exitCode: frame.exitCode,
      stdout: frame.ok ? '' : null,
      stdoutBytes: frame.ok ? Buffer.alloc(0) : null,
      error: frame.error,
      durationMs,
    };
  }
  const stdoutBytes = Buffer.from(frame.stdoutBase64, 'base64');
  if (stdoutBytes.length > SCRIPT_PROBE_MAX_STDOUT_BYTES) {
    return { ok: false, exitCode: null, stdout: null, stdoutBytes: null, error: '输出超限', durationMs };
  }
  return {
    ok: frame.ok,
    exitCode: frame.exitCode,
    stdout: frame.ok ? stdoutBytes.toString('utf8') : null,
    stdoutBytes: frame.ok ? stdoutBytes : null,
    error: frame.error,
    durationMs,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
