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
      'mao-thinking', 'mao-msg__md', 'mao-toolgroup', 'mao-thinking', 'mao-msg__md', 'mao-typing',
    ]);
    expect(el.querySelectorAll('.mao-typing span')).toHaveLength(3);
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
    expect(el.querySelector('.mao-typing')).toBeNull();
    button.click();
    await nextTick();
    expect(el.querySelector('.mao-toolcard')).toBeNull();
  });
});

describe('MessageBubble typing dots', () => {
  it('工具执行中不显示三点，结束后等待下一轮输出时显示', async () => {
    const store = new ChatStore();
    store.bindSession(1);
    const send = (type: string, data: Record<string, unknown>) => {
      store.handleEvent({ type, sessionId: 1, data } as WsServerEvent);
    };
    send('tool_call_start', { tool_call_id: 't1', tool_name: 'glob_search' });
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({ render: () => h(MessageBubble, { message: store.messages.value[0] }) });
    app.mount(el);
    expect(el.querySelector('.mao-typing')).toBeNull();

    send('tool_call_result', { tool_call_id: 't1', status: 'success', result: 'ok' });
    await nextTick();
    expect(el.querySelectorAll('.mao-typing span')).toHaveLength(3);
  });
});

describe('MessageBubble screenshot thumbnail', () => {
  const preview = 'data:image/png;base64,aaa';

  function setupShot() {
    const store = new ChatStore();
    store.bindSession(1);
    store.handleEvent({
      type: 'tool_call_start', sessionId: 1,
      data: { tool_call_id: 't1', tool_name: 'page_screenshot' },
    } as WsServerEvent);
    store.attachImageToRunningTool('page_screenshot', preview);
    store.handleEvent({
      type: 'tool_call_result', sessionId: 1,
      data: { tool_call_id: 't1', result: '{}', summary: '截取页面截图', status: 'success' },
    } as WsServerEvent);
    store.messages.value[0].streaming = false;
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({ render: () => h(MessageBubble, { message: store.messages.value[0] }) });
    app.mount(el);
  }

  it('截图默认折叠，展开后显示缩略图，点击查看大图', async () => {
    setupShot();
    expect(el.querySelector('.mao-toolcard__image')).toBeNull();
    expect(el.querySelector('.mao-lightbox')).toBeNull();
    el.querySelector('button')!.click();
    await nextTick();
    const thumb = el.querySelector('.mao-toolcard__thumb') as HTMLButtonElement;
    const img = el.querySelector('.mao-toolcard__image') as HTMLImageElement;
    expect(thumb.title).toBe('查看大图');
    expect(img.src).toBe(preview);
    thumb.click();
    await nextTick();
    expect(el.querySelector('.mao-lightbox')).not.toBeNull();
    expect((el.querySelector('.mao-lightbox__img') as HTMLImageElement).src).toBe(preview);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(el.querySelector('.mao-lightbox')).toBeNull();
  });
});

describe('MessageBubble quote', () => {
  it('用户气泡回显选中引用，正文仍是提问', () => {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({
      render: () => h(MessageBubble, {
        message: {
          id: 'u1',
          role: 'user',
          content: '帮我看下',
          thinking: '',
          streaming: false,
          error: false,
          segments: [],
          toolCalls: [],
          quotedSelection: '不健康实例 telemetry 10.140.0.96:8080',
        },
      }),
    });
    app.mount(el);
    expect(el.querySelector('.mao-msg__quote-label')?.textContent).toBe('讨论');
    expect(el.querySelector('.mao-msg__quote-text')?.textContent).toBe('不健康实例 telemetry 10.140.0.96:8080');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('帮我看下');
  });
});

describe('MessageBubble attachments', () => {
  function render(content: string, images?: string[]) {
    el = document.createElement('div');
    document.body.appendChild(el);
    app = createApp({
      render: () => h(MessageBubble, {
        message: {
          id: 'u2',
          role: 'user',
          content,
          thinking: '',
          streaming: false,
          error: false,
          segments: [],
          toolCalls: [],
          ...(images ? { images } : {}),
        },
      }),
    });
    app.mount(el);
  }

  it('图片附件显示为缩略图，正文照常显示', () => {
    render('看下这张图', ['https://mao.example.com/uploads/a.png']);
    const img = el.querySelector('.mao-msg__image') as HTMLImageElement;
    expect(img.src).toBe('https://mao.example.com/uploads/a.png');
    expect(img.alt).toBe('附件图片');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('看下这张图');
  });

  it('文件引用显示为文件名 chip，正文不出现 @{路径}@ 标记', () => {
    render('帮我看看\n@{/opt/mao/data/runtime/2/1/incoming/报告.pdf}@');
    const chip = el.querySelector('.mao-msg__file') as HTMLElement;
    expect(chip.textContent?.trim()).toBe('报告.pdf');
    expect(chip.title).toBe('/opt/mao/data/runtime/2/1/incoming/报告.pdf');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('帮我看看');
    expect(el.textContent).not.toContain('@{');
  });

  it('只有附件没有正文时不渲染空文本节点', () => {
    render('@{/tmp/a.pdf}@');
    expect(el.querySelector('.mao-msg__file')).not.toBeNull();
    expect(el.querySelector('.mao-msg__text')).toBeNull();
  });
});
