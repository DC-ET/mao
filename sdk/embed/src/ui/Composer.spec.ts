import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import Composer from './Composer.vue';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mount(overrides: { running?: boolean; quotedSelection?: string | null; connectionError?: boolean } = {}) {
  const props = reactive({
    running: false,
    quotedSelection: null as string | null,
    connectionError: false,
    ...overrides,
  });
  const sent: string[] = [];
  let stopped = 0;
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () =>
      h(Composer, {
        ...props,
        onSend: (content: string) => sent.push(content),
        onStop: () => stopped++,
      }),
  });
  app.mount(el);
  return { props, sent, stopped: () => stopped, input: () => el.querySelector('textarea')! };
}

describe('Composer', () => {
  it('Agent 输出过程中不禁用输入框，草稿保留且不发出', async () => {
    const state = mount({ running: true });
    const input = state.input();
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe('输入消息，Enter 发送');
    expect(el.querySelector('.mao-composer__stop')).not.toBeNull();
    expect(el.querySelector('.mao-composer__send')).toBeNull();

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
    expect(el.querySelector('.mao-composer__send')).not.toBeNull();
    input.value = '你好';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    el.querySelector<HTMLButtonElement>('.mao-composer__send')!.click();
    await nextTick();
    expect(state.sent).toEqual(['你好']);
    expect(input.value).toBe('');
  });
});
