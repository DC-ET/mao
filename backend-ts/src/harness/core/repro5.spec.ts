import { describe, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { CrashRecoveryRunner } from './crash-recovery-runner.js';

vi.mock('../../session/ws/ws-streaming-event-listener.js', () => ({
  WsStreamingEventListener: class {},
}));

describe('repro5', () => {
  it('snapshot vs scan ids', async () => {
    vi.useFakeTimers();
    const dir = useTmpDir('mao-repro5-');
    writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
      startedAt: Math.floor(Date.now() / 1000), oldPort: 9080, newPort: 9081, status: 'starting', drainSec: 60,
    }));
    let pass = 0;
    const sessionMapper = {
      selectByPhase: vi.fn(async (phase: string) => {
        pass++;
        const ids = pass === 1 ? [1] : [1, 2];
        return ids.map((id) => ({ id, userId: 42, sessionType: 'DEFAULT', phase, modelId: null }));
      }),
      selectById: vi.fn(async (id: number) => ({ id, userId: 42, sessionType: 'DEFAULT', phase: 'RUNNING', modelId: null })),
    };
    const runner = new CrashRecoveryRunner(
      sessionMapper as never,
      { cleanupIncompleteTail: async () => 0, updatePhase: async () => {} } as never,
      { finishExecution: async () => {} } as never,
      { execute: async () => {} } as never,
      { registerCancelFlag: () => ({ get: () => false }), removeCancelFlag: () => {} } as never,
      { send: () => {} } as never,
      {} as never,
      { clear: () => {} } as never,
      { selectBySessionId: async () => [] } as never,
      { selectById: async () => null, selectDefault: async () => null } as never,
      dir,
      { submit: (fn: () => Promise<void>) => { void fn(); } },
    );
    await runner.run();
    await vi.advanceTimersByTimeAsync(60_000);
    console.log('CALLS-AFTER-60', JSON.stringify(sessionMapper.selectById.mock.calls.map((c: unknown[]) => c[0])));
    await vi.advanceTimersByTimeAsync(15_000);
    console.log('CALLS-AFTER-75', JSON.stringify(sessionMapper.selectById.mock.calls.map((c: unknown[]) => c[0])));
    vi.useRealTimers();
  });
});
