import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, reactive, type App } from 'vue';
import HistoryPanel from './HistoryPanel.vue';
import { formatRelativeTime } from './historyTime';

interface Emitted {
  select: number[];
  newSession: number;
  loadMore: number;
  close: number;
}

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mountPanel(overrides: Record<string, unknown> = {}) {
  const props = reactive({
    open: true,
    items: [
      { id: 1, title: '当前会话', updatedAt: '2026-09-11 10:00:00', phase: null },
      { id: 2, title: '旧会话', updatedAt: '2026-09-10 10:00:00', phase: null },
      { id: 3, title: null, updatedAt: null, phase: null },
    ],
    loading: false,
    hasMore: false,
    error: null,
    activeSessionId: 1,
    ...overrides,
  });
  const emitted: Emitted = { select: [], newSession: 0, loadMore: 0, close: 0 };
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () => h(HistoryPanel, {
      ...props,
      onSelect: (id: number) => emitted.select.push(id),
      onNewSession: () => emitted.newSession++,
      onLoadMore: () => emitted.loadMore++,
      onClose: () => emitted.close++,
    }),
  });
  app.mount(el);
  return { props, emitted };
}

describe('HistoryPanel', () => {
  it('渲染列表项与当前会话高亮', async () => {
    mountPanel();
    const items = [...el.querySelectorAll('.mao-history__item')];
    expect(items).toHaveLength(3);
    expect(items[0].classList.contains('mao-history__item--active')).toBe(true);
    expect(items[1].classList.contains('mao-history__item--active')).toBe(false);
    // 空标题回退
    expect(items[2].textContent).toContain('未命名会话');
    expect(el.textContent).toContain('没有更多了');
  });

  it('点击列表项触发 select，点击新对话触发 newSession', async () => {
    const { emitted } = mountPanel();
    const items = [...el.querySelectorAll('.mao-history__item')] as HTMLElement[];
    items[1].click();
    expect(emitted.select).toEqual([2]);
    (el.querySelector('.mao-history__new') as HTMLElement).click();
    expect(emitted.newSession).toBe(1);
  });

  it('空列表显示空态，错误显示错误文案', async () => {
    mountPanel({ items: [] });
    expect(el.textContent).toContain('暂无历史对话');
    app?.unmount();
    el.remove();
    mountPanel({ items: [], error: '加载失败' });
    expect(el.textContent).toContain('加载失败');
    expect(el.textContent).not.toContain('暂无历史对话');
  });

  it('hasMore 时显示加载更多入口并触发 loadMore', async () => {
    const { emitted } = mountPanel({ hasMore: true });
    const more = el.querySelector('.mao-history__more') as HTMLElement;
    expect(more.textContent).toContain('加载更多');
    more.click();
    expect(emitted.loadMore).toBe(1);
  });

  it('open=false 不渲染', async () => {
    mountPanel({ open: false });
    expect(el.querySelector('.mao-history')).toBeNull();
  });

  it('收起按钮触发 close', async () => {
    const { emitted } = mountPanel();
    (el.querySelector('.mao-history__head button') as HTMLElement).click();
    expect(emitted.close).toBe(1);
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-11T12:00:00');

  it('分钟内与小时内', () => {
    expect(formatRelativeTime('2026-09-11 11:59:40', now)).toBe('刚刚');
    expect(formatRelativeTime('2026-09-11 11:30:00', now)).toBe('30 分钟前');
  });

  it('当天显示时间，昨天与一周内显示天数', () => {
    expect(formatRelativeTime('2026-09-11 01:05:00', now)).toBe('01:05');
    expect(formatRelativeTime('2026-09-10 23:00:00', now)).toBe('昨天');
    expect(formatRelativeTime('2026-09-08 12:00:00', now)).toBe('3 天前');
  });

  it('超过一周显示日期，空值与非法值返回空串', () => {
    expect(formatRelativeTime('2026-08-20 12:00:00', now)).toBe('2026-08-20');
    expect(formatRelativeTime(null, now)).toBe('');
    expect(formatRelativeTime('garbage', now)).toBe('');
  });
});
