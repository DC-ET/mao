import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, type App } from 'vue';
import MessageBubble from './MessageBubble.vue';
import type { ChatMessage } from '../types';

/**
 * 用户气泡渲染（引用 / 图片附件 / 文件 chip）。
 * 助手执行过程（思考行、工具组、轮次折叠）在 ChatPanel.rounds.spec.ts 覆盖。
 */

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function render(message: Partial<ChatMessage> & Pick<ChatMessage, 'role' | 'content'>) {
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () => h(MessageBubble, {
      message: {
        id: 'u1',
        thinking: '',
        streaming: false,
        error: false,
        segments: [],
        toolCalls: [],
        ...message,
      } as ChatMessage,
    }),
  });
  app.mount(el);
}

describe('MessageBubble quote', () => {
  it('用户气泡回显选中引用，正文仍是提问', () => {
    render({
      role: 'user',
      content: '帮我看下',
      quotedSelection: '不健康实例 telemetry 10.140.0.96:8080',
    });
    expect(el.querySelector('.mao-msg__quote-label')?.textContent).toBe('讨论');
    expect(el.querySelector('.mao-msg__quote-text')?.textContent).toBe('不健康实例 telemetry 10.140.0.96:8080');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('帮我看下');
  });
});

describe('MessageBubble attachments', () => {
  it('图片附件显示为缩略图，正文照常显示', () => {
    render({ role: 'user', content: '看下这张图', images: ['https://mao.example.com/uploads/a.png'] });
    const img = el.querySelector('.mao-msg__image') as HTMLImageElement;
    expect(img.src).toBe('https://mao.example.com/uploads/a.png');
    expect(img.alt).toBe('附件图片');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('看下这张图');
  });

  it('文件引用显示为文件名 chip，正文不出现 @{路径}@ 标记', () => {
    render({ role: 'user', content: '帮我看看\n@{/opt/mao/data/runtime/2/1/incoming/报告.pdf}@' });
    const chip = el.querySelector('.mao-msg__file') as HTMLElement;
    expect(chip.textContent?.trim()).toBe('报告.pdf');
    expect(chip.title).toBe('/opt/mao/data/runtime/2/1/incoming/报告.pdf');
    expect(el.querySelector('.mao-msg__text')?.textContent).toBe('帮我看看');
    expect(el.textContent).not.toContain('@{');
  });

  it('只有附件没有正文时不渲染空文本节点', () => {
    render({ role: 'user', content: '@{/tmp/a.pdf}@' });
    expect(el.querySelector('.mao-msg__file')).not.toBeNull();
    expect(el.querySelector('.mao-msg__text')).toBeNull();
  });
});
