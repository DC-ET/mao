import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { SessionEnvelopeBuilder } from './session-envelope-builder.js';

function newBuilder(envVariableService?: { resolveForSession: (userId: number, workspace: string | null) => Promise<Record<string, string>> }) {
  const root = useTmpDir('mao-envelope-');
  return new SessionEnvelopeBuilder({
    runtimeResolver: RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'users')),
    envVariableService,
  }, join(root, 'deps'));
}

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
});
