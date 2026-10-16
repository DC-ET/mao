import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import Launcher from './Launcher.vue';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mount() {
  const props = reactive({ visible: true, position: 'right' as 'right' | 'left', running: false, attention: false });
  let clicks = 0;
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({ render: () => h(Launcher, { ...props, onClick: () => clicks++ }) });
  app.mount(el);
  return { props, clicks: () => clicks };
}

describe('Launcher', () => {
  it('使用品牌图标和具名原生按钮，点击仍打开助手', () => {
    const state = mount();
    const button = el.querySelector('button')!;
    expect(button.type).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('打开 Mao 助手');
    const icon = button.querySelector<HTMLImageElement>('.mao-brand-icon')!;
    // 品牌位图（深色圆盘 + 金羽）替代原矢量标识：仍须装饰性、不阻挡点击
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    expect(icon.getAttribute('alt')).toBe('');
    expect(icon.getAttribute('draggable')).toBe('false');
    expect(icon.src).toMatch(/\.png$/);
    button.click();
    expect(state.clicks()).toBe(1);
  });

  it('保留左右定位、运行与未读状态，以及宿主隐藏入口能力', async () => {
    const { props } = mount();
    props.position = 'left';
    props.running = true;
    props.attention = true;
    await nextTick();
    expect(el.querySelector('button')?.dataset.pos).toBe('left');
    expect(el.querySelector('.mao-launcher__spinner')).not.toBeNull();
    expect(el.querySelector('.mao-launcher__dot')).not.toBeNull();
    expect(el.querySelector('button')?.getAttribute('aria-label')).toContain('正在处理');
    props.running = false;
    await nextTick();
    expect(el.querySelector('.mao-launcher__spinner')).toBeNull();
    expect(el.querySelector('button')?.getAttribute('aria-label')).toContain('有新消息');
    props.visible = false;
    await nextTick();
    expect(el.querySelector('button')).toBeNull();
  });

  it('朗读名使用 Agent 名称', async () => {
    const props = reactive({
      visible: true,
      position: 'right' as const,
      running: false,
      attention: false,
      agentName: '客服助手',
    });
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({ render: () => h(Launcher, props) });
    app.mount(el);
    expect(el.querySelector('button')?.getAttribute('aria-label')).toBe('打开 客服助手');
    props.running = true;
    await nextTick();
    expect(el.querySelector('button')?.getAttribute('aria-label')).toBe('客服助手，正在处理');
  });
});
