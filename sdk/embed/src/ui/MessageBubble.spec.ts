import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, type App } from 'vue';
import { ChatStore } from '../core/store';
import type { WsServerEvent } from '@mao/contracts';
import MessageBubble from './MessageBubble.vue';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function setup() {
  const store = new ChatStore();
  store.bindSession(1);
  const send = (type: string, data: Record<string, unknown>) => {
    store.handleEvent({ type, sessionId: 1, data } as WsServerEvent);
  };
  send('thinking_delta', { delta: '第一轮思考' });
  send('content_delta', { delta: '准备搜索' });
  send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search', arguments: '{"pattern":"*"}' });
  send('tool_call_start', { tool_call_id: 't2', tool_name: 'read_file' });
  send('thinking_delta', { delta: '第二轮思考' });
  send('content_delta', { delta: '**最终回答**' });
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({ render: () => h(MessageBubble, { message: store.messages.value[0] }) });
  app.mount(el);
  return { store, send };
}

describe('MessageBubble timeline', () => {
  it('保持穿插时序，思考和工具在执行中也默认折叠，正文可见', () => {
    setup();
    const nodes = [...el.querySelector('.mao-msg__bubble')!.children];
    expect(nodes.map((node) => node.className)).toEqual([
      'mao-thinking', 'mao-msg__md', 'mao-toolgroup', 'mao-thinking', 'mao-msg__md mao-cursor',
    ]);
    expect([...el.querySelectorAll('details')].every((node) => !node.open)).toBe(true);
    expect(el.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.mao-toolcard')).toBeNull();
    expect(el.querySelector('button')?.textContent).toContain('2 个执行中');
    expect(el.querySelector('strong')?.textContent).toBe('最终回答');
  });

  it('历史缺失结果明确提示，不显示为仍在执行', async () => {
    const { store } = setup();
    store.messages.value[0].streaming = false;
    store.messages.value[0].toolCalls.forEach((tc) => { tc.status = 'unknown'; });
    await nextTick();
    const button = el.querySelector('button')!;
    expect(button.textContent).toContain('2 个结果未记录');
    expect(button.textContent).not.toContain('执行中');
    button.click();
    await nextTick();
    expect(el.querySelector('.mao-toolcard__status')?.textContent).toContain('结果未记录');
  });

  it('展开可查看参数结果，流式状态更新及结束不重置用户的展开选择', async () => {
    const { send } = setup();
    const button = el.querySelector('button')!;
    button.click();
    await nextTick();
    expect(el.querySelectorAll('.mao-toolcard')).toHaveLength(2);
    expect(el.querySelector('.mao-toolcard__args')?.textContent).toBe('{"pattern":"*"}');
    send('tool_call_result', { tool_call_id: 't1', status: 'error', result: '<script>bad()</script>' });
    send('tool_call_result', { tool_call_id: 't2', status: 'success', result: '读取完成' });
    send('message_end', {});
    await nextTick();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.textContent).toContain('1 个失败');
    expect(button.textContent).toContain('执行结束');
    expect(el.querySelector('.mao-toolcard__result')?.textContent).toBe('<script>bad()</script>');
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('.mao-cursor')).toBeNull();
    button.click();
    await nextTick();
    expect(el.querySelector('.mao-toolcard')).toBeNull();
  });
});
