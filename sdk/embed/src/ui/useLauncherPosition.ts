import { computed, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue';

type Side = 'left' | 'right';
interface Dock { side: Side; ratio: number }
export const POSITION_KEY = 'mao_embed_launcher_position';
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, Math.max(min, max)));

export function readDock(): Dock | null {
  try {
    const data = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    return data && (data.side === 'left' || data.side === 'right') &&
      typeof data.ratio === 'number' && Number.isFinite(data.ratio) && data.ratio >= 0 && data.ratio <= 1
      ? { side: data.side, ratio: data.ratio } : null;
  } catch { return null; }
}

/** 只保存站点级 UI 偏好，不与账号、会话或认证存储耦合。 */
export function useLauncherPosition(defaultSide: () => Side) {
  const viewport = ref(measure());
  const dock = ref<Dock | null>(readDock());
  const moving = ref<{ x: number; y: number } | null>(null);
  const dragging = ref(false);
  let gesture: { id: number; x: number; y: number; left: number; top: number; target: HTMLElement } | null = null;
  let suppressClick = false;
  function measure() {
    const v = window.visualViewport;
    return { width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight,
      left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, mobile: window.innerWidth <= 480 };
  }
  const size = computed(() => viewport.value.mobile ? 52 : 56);
  const margin = computed(() => viewport.value.mobile ? 16 : 24);
  const side = computed(() => dock.value?.side ?? defaultSide());
  const point = computed(() => {
    const v = viewport.value;
    const gap = margin.value;
    const travel = Math.max(0, v.height - gap * 2 - size.value);
    return moving.value ?? {
      x: v.left + (side.value === 'left' ? gap : Math.max(gap, v.width - gap - size.value)),
      y: v.top + gap + (dock.value?.ratio ?? 1) * travel,
    };
  });
  const launcherStyle = computed<CSSProperties>(() => ({
    left: `${point.value.x}px`, top: `${point.value.y}px`, right: 'auto', bottom: 'auto',
  }));
  const panelStyle = computed<CSSProperties>(() => {
    const v = viewport.value;
    const gap = Math.min(margin.value, v.width / 4);
    const width = Math.min(408, Math.max(0, v.width - gap * 2));
    const above = point.value.y - v.top - gap - 12;
    const below = v.top + v.height - gap - point.value.y - size.value - 12;
    const upward = above >= below;
    const height = Math.min(640, Math.max(0, upward ? above : below));
    const x = side.value === 'left' ? point.value.x : point.value.x + size.value - width;
    const y = upward ? point.value.y - 12 - height : point.value.y + size.value + 12;
    return { left: `${clamp(x, v.left + gap, v.left + v.width - gap - width)}px`,
      top: `${clamp(y, v.top + gap, v.top + v.height - gap - height)}px`,
      right: 'auto', bottom: 'auto', width: `${width}px`, height: `${height}px`,
      transformOrigin: `${side.value} ${upward ? 'bottom' : 'top'}` };
  });
  function cancel(release = true) {
    const previous = gesture;
    gesture = null;
    moving.value = null;
    dragging.value = false;
    // pointerup/pointercancel 后浏览器自动释放；主动提前释放会让触摸合成 click 丢失。
    if (release && previous?.target.hasPointerCapture(previous.id)) {
      previous.target.releasePointerCapture(previous.id);
    }
  }
  function resize() { cancel(); viewport.value = measure(); }
  function pointerDown(e: PointerEvent) {
    if (!e.isPrimary || e.button !== 0 || gesture) return;
    suppressClick = false;
    const target = e.currentTarget as HTMLElement;
    gesture = { id: e.pointerId, x: e.clientX, y: e.clientY,
      left: point.value.x, top: point.value.y, target };
  }
  function pointerMove(e: PointerEvent) {
    if (!gesture || gesture.id !== e.pointerId) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if (!dragging.value && Math.hypot(dx, dy) < 6) return;
    if (!dragging.value) gesture.target.setPointerCapture(e.pointerId);
    dragging.value = true;
    suppressClick = true;
    const v = viewport.value;
    moving.value = {
      x: clamp(gesture.left + dx, v.left + margin.value, v.left + v.width - margin.value - size.value),
      y: clamp(gesture.top + dy, v.top + margin.value, v.top + v.height - margin.value - size.value),
    };
  }
  function pointerUp(e: PointerEvent) {
    if (!gesture || gesture.id !== e.pointerId) return false;
    const touchTap = e.pointerType === 'touch' && !dragging.value;
    if (dragging.value) {
      const v = viewport.value;
      const travel = v.height - margin.value * 2 - size.value;
      dock.value = {
        side: point.value.x + size.value / 2 < v.left + v.width / 2 ? 'left' : 'right',
        ratio: travel > 0 ? clamp((point.value.y - v.top - margin.value) / travel, 0, 1) : 0,
      };
      try { localStorage.setItem(POSITION_KEY, JSON.stringify(dock.value)); }
      catch { /* 存储被宿主浏览器禁用时仍允许当次调整，不影响对话。 */ }
    }
    cancel(false);
    // 触摸轻点由 pointerup 激活，合成 click 统一抑制，避免拖动后浏览器不再合成 click。
    if (touchTap) suppressClick = true;
    return touchTap;
  }
  function pointerCancel(e: PointerEvent) { if (gesture?.id === e.pointerId) cancel(false); }
  function allowClick(e: MouseEvent) {
    // 键盘/辅助技术的激活不属于拖动合成 click。
    if (suppressClick && e.detail !== 0) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
    return true;
  }
  onMounted(() => {
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
  });
  onBeforeUnmount(() => {
    cancel();
    window.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('resize', resize);
    window.visualViewport?.removeEventListener('scroll', resize);
  });
  return { side, dragging, launcherStyle, panelStyle, pointerDown, pointerMove, pointerUp, pointerCancel, allowClick };
}
