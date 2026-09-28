import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionActivityHeartbeat } from './session-activity-heartbeat.js';

function makeHeartbeat() {
  const sessionService = { touchLastActivity: vi.fn(async () => undefined) };
  const heartbeat = new SessionActivityHeartbeat(sessionService as never);
  return { heartbeat, sessionService };
}

describe('SessionActivityHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startWritesImmediatelyAndKeepsTickingUntilStop', async () => {
    vi.useFakeTimers();
    const { heartbeat, sessionService } = makeHeartbeat();
    heartbeat.start(7);
    // 执行开始立即刷新一次，长工具调用期间再按间隔持续刷新。
    expect(sessionService.touchLastActivity).toHaveBeenCalledWith(7);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(4);

    heartbeat.stop(7);
    sessionService.touchLastActivity.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionService.touchLastActivity).not.toHaveBeenCalled();
  });

  it('ticksAreNotSuppressedByThrottledTouch', async () => {
    vi.useFakeTimers();
    const { heartbeat, sessionService } = makeHeartbeat();
    // 轮级 touch 与定时心跳共用同一节流窗口，定时心跳必须绕过节流按间隔落库。
    heartbeat.touch(3);
    heartbeat.start(3);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(3);
  });

  it('nestedStartsAreReferenceCounted', async () => {
    vi.useFakeTimers();
    const { heartbeat, sessionService } = makeHeartbeat();
    heartbeat.start(9);
    heartbeat.start(9);
    heartbeat.stop(9);
    sessionService.touchLastActivity.mockClear();
    // 内层结束后外层仍在执行，心跳不能停。
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionService.touchLastActivity).toHaveBeenCalledTimes(1);

    heartbeat.stop(9);
    sessionService.touchLastActivity.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionService.touchLastActivity).not.toHaveBeenCalled();
  });

  it('stopAllClearsEveryTimer', async () => {
    vi.useFakeTimers();
    const { heartbeat, sessionService } = makeHeartbeat();
    heartbeat.start(1);
    heartbeat.start(2);
    heartbeat.stopAll();
    sessionService.touchLastActivity.mockClear();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sessionService.touchLastActivity).not.toHaveBeenCalled();
  });

  it('ignoresNullSessionId', async () => {
    const { heartbeat, sessionService } = makeHeartbeat();
    heartbeat.start(null);
    heartbeat.stop(null);
    heartbeat.clear(null);
    expect(sessionService.touchLastActivity).not.toHaveBeenCalled();
  });
});
