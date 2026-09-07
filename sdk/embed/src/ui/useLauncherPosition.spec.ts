import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { POSITION_KEY, readDock, useLauncherPosition } from './useLauncherPosition';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); localStorage.clear(); });
function mount() {
  let placement!: ReturnType<typeof useLauncherPosition>;
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({ setup() { placement = useLauncherPosition(() => 'right'); return () => h('div'); } });
  app.mount(el);
  const target = document.createElement('button');
  target.setPointerCapture = () => {};
  target.hasPointerCapture = () => false;
  const event = (x: number, y: number, id = 1) => ({
    pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: y, currentTarget: target,
  }) as unknown as PointerEvent;
  return { placement, event };
}

describe('launcher position', () => {
  it('默认按配置贴右下；超过阈值才拖动，松手贴左并记忆，抑制拖动click但不影响键盘', () => {
    const { placement: p, event } = mount();
    expect(p.side.value).toBe('right');
    p.pointerDown(event(900, 600));
    p.pointerMove(event(902, 600));
    expect(p.dragging.value).toBe(false);
    p.pointerMove(event(0, 100));
    expect(p.dragging.value).toBe(true);
    p.pointerUp(event(0, 100));
    expect(p.side.value).toBe('left');
    expect(readDock()?.side).toBe('left');
    expect(p.allowClick(new MouseEvent('click', { detail: 1 }))).toBe(false);
    expect(p.allowClick(new MouseEvent('click', { detail: 0 }))).toBe(true);
    p.pointerDown(event(20, 20));
    p.pointerUp(event(20, 20));
    expect(p.allowClick(new MouseEvent('click', { detail: 1 }))).toBe(true);
  });

  it('非法存储不参与布局，合法偏好恢复，浮窗保持在视口内', async () => {
    localStorage.setItem(POSITION_KEY, '{"side":"left","ratio":8}');
    expect(readDock()).toBeNull();
    localStorage.setItem(POSITION_KEY, '{"side":"left","ratio":0}');
    const { placement: p } = mount();
    expect(p.side.value).toBe('left');
    expect(parseFloat(String(p.launcherStyle.value.top))).toBe(24);
    expect(parseFloat(String(p.panelStyle.value.top))).toBeGreaterThan(24);
    window.dispatchEvent(new Event('resize'));
    await nextTick();
    const style = p.panelStyle.value;
    expect(parseFloat(String(style.top)) + parseFloat(String(style.height))).toBeLessThanOrEqual(window.innerHeight);
    expect(parseFloat(String(style.left)) + parseFloat(String(style.width))).toBeLessThanOrEqual(window.innerWidth);
  });

  it('触摸轻点只激活一次，拖动不激活，后续轻点仍可用', () => {
    const { placement: p, event } = mount();
    const touch = (x: number, y: number) => ({ ...event(x, y), pointerType: 'touch' }) as PointerEvent;
    p.pointerDown(touch(900, 600));
    expect(p.pointerUp(touch(900, 600))).toBe(true);
    expect(p.allowClick(new MouseEvent('click', { detail: 1 }))).toBe(false);
    p.pointerDown(touch(900, 600));
    p.pointerMove(touch(40, 170));
    expect(p.pointerUp(touch(40, 170))).toBe(false);
    p.pointerDown(touch(40, 170));
    expect(p.pointerUp(touch(40, 170))).toBe(true);
  });

  it('取消拖动或窗口变化不保存中间位置，其他指针不干扰', () => {
    const { placement: p, event } = mount();
    p.pointerDown(event(900, 600));
    p.pointerMove(event(0, 0, 2));
    expect(p.dragging.value).toBe(false);
    p.pointerMove(event(0, 0));
    p.pointerCancel(event(0, 0));
    expect(p.side.value).toBe('right');
    expect(readDock()).toBeNull();
    expect(p.dragging.value).toBe(false);
  });
});
