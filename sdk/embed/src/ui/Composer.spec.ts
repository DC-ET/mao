import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import Composer from './Composer.vue';
import type { PageAuthorizationLevel } from '../page';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mount(overrides: {
  running?: boolean;
  quotedSelection?: string | null;
  pageAuthorization?: PageAuthorizationLevel;
} = {}) {
  const props = reactive({
    running: false,
    quotedSelection: null as string | null,
    pageAuthorization: 'per_action' as PageAuthorizationLevel,
    ...overrides,
  });
  const sent: string[] = [];
  let stopped = 0;
  const levels: PageAuthorizationLevel[] = [];
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () =>
      h(Composer, {
        ...props,
        onSend: (content: string) => sent.push(content),
        onStop: () => stopped++,
        onSetPageAuthorization: (level: PageAuthorizationLevel) => levels.push(level),
      }),
  });
  app.mount(el);
  return {
    props,
    sent,
    stopped: () => stopped,
    levels,
    input: () => el.querySelector('textarea')!,
  };
}

describe('Composer', () => {
  it('Agent 输出过程中不禁用输入框，草稿保留且不发出', async () => {
    const state = mount({ running: true });
    const input = state.input();
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('告诉 Agent 你想做什么...');
    expect(el.querySelector('.mao-composer__stop')).not.toBeNull();
    expect(el.querySelector('.mao-auth__stop')).toBeNull();
    expect(el.querySelector('.mao-composer__send--active')).toBeNull();

    input.value = '下一条问题';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(state.sent).toEqual([]);
    expect(input.value).toBe('下一条问题');
  });

  it('空闲时可发送并清空输入', async () => {
    const state = mount();
    const input = state.input();
    const send = el.querySelector<HTMLButtonElement>('.mao-composer__send')!;
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(true);
    input.value = '你好';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(send.classList.contains('mao-composer__send--active')).toBe(true);
    send.click();
    await nextTick();
    expect(state.sent).toEqual(['你好']);
    expect(input.value).toBe('');
  });

  it('页面授权以下拉切换，完全授权需用户显式选择', async () => {
    const state = mount();
    const badge = el.querySelector<HTMLButtonElement>('.mao-auth__badge')!;
    expect(badge.textContent).toContain('每次确认');
    badge.click();
    await nextTick();
    const options = [...el.querySelectorAll<HTMLButtonElement>('.mao-auth__option')];
    expect(options.map((o) => o.dataset.level)).toEqual(['per_action', 'task', 'full']);
    options[2].click();
    await nextTick();
    expect(state.levels).toEqual(['full']);
    expect(el.querySelector('.mao-auth__menu')).toBeNull();
    expect(el.querySelector('.mao-auth__stop')).toBeNull();
  });
});
