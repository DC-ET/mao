import { describe, expect, it, vi } from 'vitest';
import type { ContainerEntry } from './container-registry.js';
import type { ChannelConnection } from './runtime-channel-server.js';
import type { RuntimeRequestFrame } from './runtime-channel-protocol.js';
import { SCRIPT_PROBE_MAX_STDOUT_BYTES } from '../../signal/script-probe.js';
import { ContainerScriptProbe, ScriptProbeInfrastructureError } from './container-script-probe.js';

const DEPS = {
  NPM_CONFIG_PREFIX: '/deps/7/npm',
  PIP_TARGET: '/deps/7/py',
  PIP_BREAK_SYSTEM_PACKAGES: '1',
  MAO_DEPS_BIN: '/deps/7/npm/bin',
};

function probe(options: {
  ready?: boolean;
  ensureRunning?: () => Promise<ContainerEntry>;
  connection?: ChannelConnection | null;
  response?: () => Promise<unknown>;
} = {}) {
  const frames: RuntimeRequestFrame[] = [];
  const timeouts: number[] = [];
  const request = vi.fn(async (frame: RuntimeRequestFrame, timeoutMs: number) => {
    frames.push(frame);
    timeouts.push(timeoutMs);
    if (options.response) return options.response();
    const raw = Buffer.from([0x61, 0xff]);
    return {
      v: 1,
      type: 'script_probe_result',
      id: 'id' in frame ? frame.id : '',
      failureClass: 'script',
      ok: true,
      exitCode: 0,
      stdoutBase64: raw.toString('base64'),
      error: null,
      durationMs: 12,
    };
  });
  const ensureRunning = vi.fn(options.ensureRunning ?? (async () => ({ runtimeBuild: 'host-1' }) as ContainerEntry));
  const bridge = new ContainerScriptProbe({
    enabledFor: async () => true,
    ensureRunning,
    scriptProbeRuntimeReady: () => options.ready !== false,
    getConnection: () => options.connection === undefined ? { request } as unknown as ChannelConnection : options.connection,
    depsEnvOf: () => DEPS,
  });
  return { bridge, frames, timeouts, ensureRunning, request };
}

const input = {
  userId: 7,
  agentId: 3,
  scriptPath: '/data/workspace/7/projects/check.sh',
  timeoutSeconds: 10,
  env: {
    PATH: '/evil',
    HOME: '/data/users/7',
    TZ: 'Asia/Shanghai',
    MAO_WATCHER_ID: '9',
    MAO_WATCHER_NAME: '磁盘',
    APP_SIGNAL_SECRET: 'secret',
  },
};

describe('ContainerScriptProbe', () => {
  it('版本一致时发帧，丢掉 PATH 与宿主密钥，并还原 stdout 字节', async () => {
    const { bridge, frames, timeouts } = probe();
    const result = await bridge.execute(input);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe('script_probe');
    if (frame.type !== 'script_probe') return;
    expect(frame.env).toEqual({
      HOME: '/data/users/7',
      TZ: 'Asia/Shanghai',
      MAO_WATCHER_ID: '9',
      MAO_WATCHER_NAME: '磁盘',
    });
    expect(frame.deps).toEqual(DEPS);
    expect(frame.scriptPath).toBe(input.scriptPath);
    expect(timeouts[0]).toBe(25_000);
    expect(result.ok).toBe(true);
    expect(result.stdoutBytes).toEqual(Buffer.from([0x61, 0xff]));
    expect(result.durationMs).toBe(12);
  });

  it('版本不一致、容器起不来、通道缺失或超时都不发到宿主执行', async () => {
    const drifted = probe({ ready: false });
    await expect(drifted.bridge.execute(input)).rejects.toThrow(ScriptProbeInfrastructureError);
    await expect(drifted.bridge.execute(input)).rejects.toThrow(/版本待升级/);
    expect(drifted.request).not.toHaveBeenCalled();

    const down = probe({ ensureRunning: async () => { throw new Error('docker down'); } });
    await expect(down.bridge.execute(input)).rejects.toThrow(/容器未就绪：docker down/);
    expect(down.request).not.toHaveBeenCalled();

    const offline = probe({ connection: null });
    await expect(offline.bridge.execute(input)).rejects.toThrow(/通道未连接/);

    const timedOut = probe({ response: async () => { throw new Error('timeout after 25000ms'); } });
    await expect(timedOut.bridge.execute(input)).rejects.toThrow(/容器通道无响应/);
  });

  it('容器回报基础设施失败或超限 stdout 时不把字节交给判定', async () => {
    const infra = probe({
      response: async () => ({
        v: 1, type: 'script_probe_result', id: 'x', failureClass: 'infrastructure',
        ok: false, exitCode: null, stdoutBase64: null, error: '容器身份缺失', durationMs: 0,
      }),
    });
    await expect(infra.bridge.execute(input)).rejects.toThrow(/容器身份缺失/);

    const huge = Buffer.alloc(SCRIPT_PROBE_MAX_STDOUT_BYTES + 1, 1);
    const over = probe({
      response: async () => ({
        v: 1, type: 'script_probe_result', id: 'x', failureClass: 'script',
        ok: true, exitCode: 0, stdoutBase64: huge.toString('base64'), error: null, durationMs: 3,
      }),
    });
    const result = await over.bridge.execute(input);
    expect(result).toMatchObject({ ok: false, error: '输出超限', stdout: null, stdoutBytes: null });
  });
});
