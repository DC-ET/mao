import { afterEach, describe, expect, it } from 'vitest';
import { createApp, h, nextTick, reactive, type App } from 'vue';
import Composer from './Composer.vue';
import type { PageAuthorizationLevel } from '../page';
import type { PendingAttachment } from '../core/attachment';

let app: App | undefined;
let el: HTMLDivElement;
afterEach(() => { app?.unmount(); el?.remove(); });

function mount(overrides: {
  running?: boolean;
  quotedSelection?: string | null;
  pageAuthorization?: PageAuthorizationLevel;
  maxAttachmentMb?: number;
} = {}) {
  const props = reactive({
    running: false,
    quotedSelection: null as string | null,
    pageAuthorization: 'per_action' as PageAuthorizationLevel,
    maxAttachmentMb: 5,
    ...overrides,
  });
  const sent: Array<{ content: string; attachments: PendingAttachment[] }> = [];
  let stopped = 0;
  const levels: PageAuthorizationLevel[] = [];
  el = document.createElement('div');
  document.body.appendChild(el);
  app = createApp({
    render: () =>
      h(Composer, {
        ...props,
        onSend: (content: string, attachments: PendingAttachment[]) => sent.push({ content, attachments }),
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
    send: () => el.querySelector<HTMLButtonElement>('.mao-composer__send')!,
    attachments: () => [...el.querySelectorAll('.mao-attach')],
  };
}

/** 构造带文件的粘贴事件：happy-dom 的 ClipboardEvent 不接 clipboardData 初值，手工挂载 */
function paste(input: HTMLElement, files: File[], text?: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: files.map((file) => ({ kind: 'file', getAsFile: () => file })),
      files,
      getData: (type: string) => (type === 'text/plain' ? (text ?? '') : ''),
    },
  });
  input.dispatchEvent(event);
  return event;
}

function imageFile(name = 'shot.png', bytes = 8) {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
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
    const send = state.send();
    expect(send).not.toBeNull();
    expect(send.disabled).toBe(true);
    input.value = '你好';
    input.dispatchEvent(new Event('input'));
    await nextTick();
    expect(send.classList.contains('mao-composer__send--active')).toBe(true);
    send.click();
    await nextTick();
    expect(state.sent.map((s) => s.content)).toEqual(['你好']);
    expect(input.value).toBe('');
  });

  it('粘贴图片后显示缩略图，发送时随附件送出并清空', async () => {
    const state = mount();
    const input = state.input();
    const file = imageFile();
    const event = paste(input, [file]);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    const items = state.attachments();
    expect(items).toHaveLength(1);
    expect(items[0].querySelector('.mao-attach__thumb')).not.toBeNull();
    expect(items[0].textContent).toContain('shot.png');
    expect(state.send().disabled).toBe(false);

    state.send().click();
    await nextTick();
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].content).toBe('');
    expect(state.sent[0].attachments.map((a) => a.file.name)).toEqual(['shot.png']);
    expect(state.attachments()).toHaveLength(0);
    expect(state.send().disabled).toBe(true);
  });

  it('粘贴非图片文件显示文件 chip 与大小，可单独移除', async () => {
    const state = mount();
    const input = state.input();
    paste(input, [new File([new Uint8Array(2048)], '报告.pdf', { type: 'application/pdf' })]);
    await nextTick();
    expect(state.attachments()).toHaveLength(1);
    expect(el.textContent).toContain('报告.pdf');
    expect(el.textContent).toContain('2 KB');

    el.querySelector<HTMLButtonElement>('.mao-attach__close')!.click();
    await nextTick();
    expect(state.attachments()).toHaveLength(0);
  });

  it('超过大小上限的附件被忽略并提示，不进入待发列表', async () => {
    const state = mount({ maxAttachmentMb: 1 });
    paste(state.input(), [new File([new Uint8Array(2 * 1024 * 1024)], 'big.bin')]);
    await nextTick();
    expect(state.attachments()).toHaveLength(0);
    expect(el.querySelector('.mao-composer__notice')?.textContent).toContain('1MB');
    expect(state.send().disabled).toBe(true);
  });

  it('纯文本粘贴不拦截，由浏览器插入输入框', async () => {
    const state = mount();
    const event = paste(state.input(), [], '一段文字');
    await nextTick();
    expect(event.defaultPrevented).toBe(false);
    expect(state.attachments()).toHaveLength(0);
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
