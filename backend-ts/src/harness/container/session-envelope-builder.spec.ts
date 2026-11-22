import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { buildDepsEnv, SessionEnvelopeBuilder } from './session-envelope-builder.js';

function newBuilder(envVariableService?: { resolveForSession: (userId: number, workspace: string | null) => Promise<Record<string, string>> }) {
  const root = useTmpDir('mao-envelope-');
  return new SessionEnvelopeBuilder({
    runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
    envVariableService,
  }, join(root, 'deps'));
}

describe('SessionEnvelopeBuilder site baseUrl', () => {
  it('carries the site baseUrl for shell/MCP MAO_BASE_URL injection', async () => {
    const root = useTmpDir('mao-envelope-');
    const builder = new SessionEnvelopeBuilder({
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      siteBaseUrlProvider: { getSiteBaseUrl: async () => 'https://mao.example.com' },
    }, join(root, 'deps'));
    const envelope = await builder.build({ userId: 7, sessionId: 9, workspace: null });
    expect(envelope.maoBaseUrl).toBe('https://mao.example.com');
  });

  it('keeps null when the site address is not configured', async () => {
    const builder = newBuilder();
    const envelope = await builder.build({ userId: 7, sessionId: 9, workspace: null });
    expect(envelope.maoBaseUrl).toBeNull();
  });
});

describe('SessionEnvelopeBuilder env vars', () => {
  it('carries the merged three-layer env vars into the envelope', async () => {
    const resolveForSession = vi.fn(async () => ({ NPM_REGISTRY: 'https://mirror.internal' }));
    const builder = newBuilder({ resolveForSession });
    const envelope = await builder.build({ userId: 7, sessionId: 9, workspace: '/tmp/ws-a' });
    expect(resolveForSession).toHaveBeenCalledWith(7, '/tmp/ws-a');
    expect(envelope.envVars).toEqual({ NPM_REGISTRY: 'https://mirror.internal' });
  });

  it('passes null workspace through (service normalizes to global root)', async () => {
    const resolveForSession = vi.fn(async () => ({}));
    const builder = newBuilder({ resolveForSession });
    await builder.build({ userId: 7, sessionId: null, workspace: null });
    expect(resolveForSession).toHaveBeenCalledWith(7, null);
  });

  it('keeps the envelope usable when env resolution fails', async () => {
    const builder = newBuilder({ resolveForSession: async () => { throw new Error('db down'); } });
    const envelope = await builder.build({ userId: 7, sessionId: 9, workspace: null });
    expect(envelope.envVars).toEqual({});
    expect(envelope.userId).toBe(7);
  });

  it('录制开关开启时 envVars 追加 MAO_BROWSER_LIVE_RECORD（V202），关闭/读取失败不追加', async () => {
    const root = useTmpDir('mao-envelope-record-');
    const make = (flag: () => Promise<boolean>) => new SessionEnvelopeBuilder({
      runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
      envVariableService: { resolveForSession: async () => ({ NPM_REGISTRY: 'https://mirror.internal' }) },
      browserLiveRecordEnabled: flag,
    }, join(root, 'deps'));

    const on = await make(async () => true).build({ userId: 7, sessionId: 9, workspace: null });
    expect(on.envVars).toEqual({ NPM_REGISTRY: 'https://mirror.internal', MAO_BROWSER_LIVE_RECORD: '1' });

    const off = await make(async () => false).build({ userId: 7, sessionId: 9, workspace: null });
    expect(off.envVars).toEqual({ NPM_REGISTRY: 'https://mirror.internal' });

    const failing = await make(async () => { throw new Error('db down'); }).build({ userId: 7, sessionId: 9, workspace: null });
    expect(failing.envVars).toEqual({ NPM_REGISTRY: 'https://mirror.internal' });
  });
});

describe('buildDepsEnv pip source', () => {
  it('injects the Tencent PyPI mirror over the image default (aliyun throttles HTTP/1.1 downloads)', () => {
    const env = buildDepsEnv('/srv/mao-data/deps', 7);
    expect(env.PIP_INDEX_URL).toBe('https://mirrors.cloud.tencent.com/pypi/simple/');
    expect(env.PIP_TRUSTED_HOST).toBe('mirrors.cloud.tencent.com');
    expect(env.PIP_TARGET).toBe('/srv/mao-data/deps/7/py');
  });
});
