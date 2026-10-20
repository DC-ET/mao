import { describe, expect, it } from 'vitest';
import { FeishuActiveProgressRegistry } from './active-progress.js';
import type { FeishuProgressHandle } from './patched-progress.js';

function fakeHandle(running = true) {
  const state = { disliked: false, renderCount: 0, refreshed: 0 };
  const handle: FeishuProgressHandle = {
    isRunning: () => running,
    refresh: async () => { state.refreshed++; },
    renderCurrent: () => { state.renderCount++; return { disliked: state.disliked }; },
    setDisliked: (value: boolean) => { state.disliked = value; },
  };
  return { handle, state };
}

describe('FeishuActiveProgressRegistry 双键', () => {
  it('bind 传 cardMessageId 后可按卡渲染与置点踩态', () => {
    const registry = new FeishuActiveProgressRegistry();
    const { handle, state } = fakeHandle();
    registry.bind(7, 'ou_1', handle, 'cm_1');
    expect(registry.renderByCard('cm_1')).toEqual({ disliked: false });
    expect(state.renderCount).toBe(1);
    registry.setDislikedByCard('cm_1', true);
    expect(state.disliked).toBe(true);
    expect(registry.renderByCard('cm_1')).toEqual({ disliked: true });
  });

  it('未绑定该卡时 renderByCard 返回 null、setDislikedByCard 静默忽略', () => {
    const registry = new FeishuActiveProgressRegistry();
    const { handle } = fakeHandle();
    registry.bind(7, 'ou_1', handle, 'cm_1');
    expect(registry.renderByCard('cm_other')).toBeNull();
    expect(() => registry.setDislikedByCard('cm_other', true)).not.toThrow();
  });

  it('同会话两张卡互不串：点旧卡只改旧卡句柄，session 键仍指向最新卡', () => {
    const registry = new FeishuActiveProgressRegistry();
    const first = fakeHandle();
    const second = fakeHandle();
    registry.bind(7, 'ou_1', first.handle, 'cm_old');
    registry.bind(7, 'ou_1', second.handle, 'cm_new');
    // 点旧完成卡：只渲染/只置态旧卡
    expect(registry.renderByCard('cm_old')).toEqual({ disliked: false });
    registry.setDislikedByCard('cm_old', true);
    expect(first.state.disliked).toBe(true);
    expect(second.state.disliked).toBe(false);
    // 会话级方法不受影响：仍指向最新任务的句柄
    expect(registry.current(7)).toBe(second.handle);
    expect(registry.render(7)).toEqual({ disliked: false });
    expect(registry.senderOpenId(7)).toBe('ou_1');
  });

  it('新任务绑定新卡后，旧卡仍可按卡渲染（旧完成卡不丢）', () => {
    const registry = new FeishuActiveProgressRegistry();
    const first = fakeHandle(false);
    const second = fakeHandle();
    registry.bind(7, 'ou_1', first.handle, 'cm_old');
    registry.bind(7, 'ou_1', second.handle, 'cm_new');
    expect(registry.renderByCard('cm_old')).toEqual({ disliked: false });
    expect(first.state.renderCount).toBe(1);
  });

  it('同一张卡重新绑定（重试/崩溃恢复）覆盖 byCard 条目', () => {
    const registry = new FeishuActiveProgressRegistry();
    const stale = fakeHandle();
    const fresh = fakeHandle();
    registry.bind(7, 'ou_1', stale.handle, 'cm_retry');
    registry.bind(7, 'ou_1', fresh.handle, 'cm_retry');
    expect(registry.renderByCard('cm_retry')).toEqual({ disliked: false });
    registry.setDislikedByCard('cm_retry', true);
    expect(stale.state.disliked).toBe(false);
    expect(fresh.state.disliked).toBe(true);
    expect(registry.current(7)).toBe(fresh.handle);
  });

  it('不传 cardMessageId 时按卡查询全部未命中，session 键行为不变', async () => {
    const registry = new FeishuActiveProgressRegistry();
    const { handle, state } = fakeHandle();
    registry.bind(7, 'ou_1', handle);
    expect(registry.renderByCard('cm_any')).toBeNull();
    expect(registry.hasRunning(7)).toBe(true);
    expect(await registry.refresh(7)).toBe(true);
    expect(state.refreshed).toBe(1);
    expect(registry.render(7)).toEqual({ disliked: false });
  });

  it('hasRunning/refresh 对终态句柄返回 false，不把完成卡刷回执行中', async () => {
    const registry = new FeishuActiveProgressRegistry();
    const { handle } = fakeHandle(false);
    registry.bind(7, 'ou_1', handle, 'cm_done');
    expect(registry.hasRunning(7)).toBe(false);
    expect(await registry.refresh(7)).toBe(false);
    // 终态卡仍可按卡渲染（点踩重绘）
    expect(registry.renderByCard('cm_done')).toEqual({ disliked: false });
  });
});
